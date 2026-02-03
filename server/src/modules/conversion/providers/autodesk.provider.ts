/**
 * Autodesk APS (Platform Services) Provider
 * 
 * Uses the Model Derivative API to convert CAD files (DWG, DXF, etc.) to mesh formats.
 * This is the authoritative solution for files with ACIS 3D solids that open-source tools cannot handle.
 * 
 * Flow: 
 * 1. Get access token (2-legged OAuth)
 * 2. Create bucket (if not exists)
 * 3. Upload file to OSS
 * 4. Create translation job to OBJ/STL
 * 5. Poll for completion
 * 6. Download result
 */

import fs from 'fs-extra';
import path from 'path';
import { ConversionError, TimeoutError } from '../../../common/errors';
import config from '../../../config/env';

// Configuration from environment
const APS_CLIENT_ID = process.env.APS_CLIENT_ID || '';
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET || '';
const APS_BUCKET_KEY = process.env.APS_BUCKET_KEY || 'tecnibo_3d_converter';

// API endpoints
const AUTH_URL = 'https://developer.api.autodesk.com/authentication/v2/token';
const OSS_URL = 'https://developer.api.autodesk.com/oss/v2';
const MODEL_DERIVATIVE_URL = 'https://developer.api.autodesk.com/modelderivative/v2/designdata';

// Supported output formats for Model Derivative API
type ApsOutputFormat = 'obj' | 'stl' | 'step' | 'iges';

interface ApsConversionOptions {
  outputFormat?: ApsOutputFormat;
  timeout?: number;
  pollInterval?: number;
}

interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// Token cache
let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Check if APS is configured and available
 */
export function isApsAvailable(): boolean {
  return !!(APS_CLIENT_ID && APS_CLIENT_SECRET);
}

/**
 * Get a two-legged access token
 */
async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 5 minute buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    throw new ConversionError('APS credentials not configured');
  }

  console.log('[APS] Obtaining access token...');

  const credentials = Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials&scope=data:write data:read bucket:create bucket:delete'
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ConversionError(`APS authentication failed: ${response.status} ${errorText}`);
  }

  const data = await response.json() as AccessTokenResponse;
  
  // Cache the token
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  };

  console.log('[APS] Access token obtained successfully');
  return data.access_token;
}

/**
 * Create OSS bucket if it doesn't exist
 */
async function ensureBucket(token: string, bucketKey: string): Promise<void> {
  console.log(`[APS] Ensuring bucket exists: ${bucketKey}`);

  // Check if bucket exists
  const checkResponse = await fetch(`${OSS_URL}/buckets/${bucketKey}/details`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (checkResponse.ok) {
    console.log('[APS] Bucket already exists');
    return;
  }

  // Create the bucket
  const createResponse = await fetch(`${OSS_URL}/buckets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ads-region': 'US'
    },
    body: JSON.stringify({
      bucketKey,
      access: 'full',
      policyKey: 'transient' // Auto-delete after 24 hours
    })
  });

  if (!createResponse.ok && createResponse.status !== 409) {
    const errorText = await createResponse.text();
    throw new ConversionError(`Failed to create bucket: ${createResponse.status} ${errorText}`);
  }

  console.log('[APS] Bucket created successfully');
}

/**
 * Upload a file to OSS
 */
async function uploadFile(token: string, bucketKey: string, filePath: string): Promise<string> {
  const objectKey = `${Date.now()}_${path.basename(filePath)}`;
  console.log(`[APS] Uploading file: ${objectKey}`);

  // Step 1: Get signed upload URL
  const signedUrlResponse = await fetch(
    `${OSS_URL}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload?minutesExpiration=15`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!signedUrlResponse.ok) {
    const errorText = await signedUrlResponse.text();
    throw new ConversionError(`Failed to get upload URL: ${signedUrlResponse.status} ${errorText}`);
  }

  const signedUrlData = await signedUrlResponse.json() as { 
    uploadKey: string; 
    urls: string[];
  };

  // Step 2: Upload to S3
  const fileBuffer = await fs.readFile(filePath);
  const uploadResponse = await fetch(signedUrlData.urls[0], {
    method: 'PUT',
    body: fileBuffer
  });

  if (!uploadResponse.ok) {
    throw new ConversionError(`Failed to upload file to S3: ${uploadResponse.status}`);
  }

  // Step 3: Finalize upload
  const finalizeResponse = await fetch(
    `${OSS_URL}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ossbucketKey: bucketKey,
        ossSourceFileObjectKey: objectKey,
        access: 'full',
        uploadKey: signedUrlData.uploadKey
      })
    }
  );

  if (!finalizeResponse.ok) {
    const errorText = await finalizeResponse.text();
    throw new ConversionError(`Failed to finalize upload: ${finalizeResponse.status} ${errorText}`);
  }

  const finalizeData = await finalizeResponse.json() as { objectId: string };
  console.log(`[APS] Upload successful: ${finalizeData.objectId}`);

  return finalizeData.objectId;
}

/**
 * Create a translation job to SVF2 (required for formats that don't support direct OBJ/STL)
 */
async function createSvf2TranslationJob(
  token: string, 
  objectId: string
): Promise<string> {
  // Convert objectId to Base64 URL-safe URN
  const urn = Buffer.from(objectId).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  console.log('[APS] Creating SVF2 translation job...');

  const response = await fetch(`${MODEL_DERIVATIVE_URL}/job`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ads-force': 'true'
    },
    body: JSON.stringify({
      input: {
        urn
      },
      output: {
        destination: { region: 'us' },
        formats: [
          {
            type: 'svf2',
            views: ['3d']
          }
        ]
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ConversionError(`Failed to create SVF2 translation job: ${response.status} ${errorText}`);
  }

  console.log('[APS] SVF2 translation job created');
  return urn;
}

/**
 * Poll for SVF2 translation completion and get the modelGuid from metadata endpoint
 */
async function pollForSvf2Completion(
  token: string, 
  urn: string,
  timeout: number,
  pollInterval: number
): Promise<string> {
  const startTime = Date.now();
  console.log('[APS] Polling for SVF2 translation completion...');

  while (Date.now() - startTime < timeout) {
    const response = await fetch(`${MODEL_DERIVATIVE_URL}/${urn}/manifest`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ConversionError(`Failed to fetch manifest: ${response.status} ${errorText}`);
    }

    const manifest = await response.json() as {
      status: string;
      progress: string;
    };

    console.log(`[APS] SVF2 Status: ${manifest.status}, Progress: ${manifest.progress}`);

    if (manifest.status === 'success') {
      // Get the modelGuid from the metadata endpoint (this is the correct approach)
      console.log('[APS] Fetching metadata to get modelGuid...');
      const metadataResponse = await fetch(`${MODEL_DERIVATIVE_URL}/${urn}/metadata`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!metadataResponse.ok) {
        const errorText = await metadataResponse.text();
        throw new ConversionError(`Failed to fetch metadata: ${metadataResponse.status} ${errorText}`);
      }

      const metadataResult = await metadataResponse.json() as {
        data?: {
          type: string;
          metadata: Array<{
            name: string;
            role: string;
            guid: string;
          }>;
        };
      };

      console.log(`[APS] Metadata response: ${JSON.stringify(metadataResult)}`);

      if (metadataResult.data?.metadata && metadataResult.data.metadata.length > 0) {
        // Find a 3D viewable
        const viewable3d = metadataResult.data.metadata.find(m => m.role === '3d');
        if (viewable3d) {
          console.log(`[APS] Found 3D viewable: ${viewable3d.name}, guid: ${viewable3d.guid}`);
          return viewable3d.guid;
        }
        // Fallback to first viewable if no 3D specific one
        const firstViewable = metadataResult.data.metadata[0];
        console.log(`[APS] Using first viewable: ${firstViewable.name}, guid: ${firstViewable.guid}`);
        return firstViewable.guid;
      }
      
      throw new ConversionError('SVF2 translation succeeded but no metadata/viewable found');
    }

    if (manifest.status === 'failed' || manifest.status === 'timeout') {
      throw new ConversionError(`SVF2 translation failed with status: ${manifest.status}`);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new TimeoutError(`SVF2 translation timed out after ${timeout}ms`);
}

/**
 * Create OBJ extraction job from SVF2
 * Using objectIds [-1] extracts the whole model
 */
async function createObjExtractionJob(
  token: string,
  urn: string,
  modelGuid: string
): Promise<void> {
  console.log(`[APS] Creating OBJ extraction job for whole model with modelGuid: ${modelGuid}`);

  const requestBody = {
    input: {
      urn
    },
    output: {
      destination: { region: 'us' },
      formats: [
        {
          type: 'obj',
          advanced: {
            modelGuid,
            objectIds: [-1] // -1 means extract the whole model
          }
        }
      ]
    }
  };

  console.log(`[APS] Request body: ${JSON.stringify(requestBody, null, 2)}`);

  const response = await fetch(`${MODEL_DERIVATIVE_URL}/job`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ads-force': 'true'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ConversionError(`Failed to create OBJ extraction job: ${response.status} ${errorText}`);
  }

  console.log('[APS] OBJ extraction job created');
}

/**
 * Create a direct translation job (for formats that support it)
 */
async function createTranslationJob(
  token: string, 
  objectId: string, 
  outputFormat: ApsOutputFormat
): Promise<string> {
  // Convert objectId to Base64 URL-safe URN
  const urn = Buffer.from(objectId).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  console.log(`[APS] Creating translation job to ${outputFormat}...`);

  const response = await fetch(`${MODEL_DERIVATIVE_URL}/job`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: {
        urn
      },
      output: {
        formats: [
          {
            type: outputFormat
          }
        ]
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ConversionError(`Failed to create translation job: ${response.status} ${errorText}`);
  }

  const data = await response.json() as { urn: string };
  console.log('[APS] Translation job created');
  
  return data.urn;
}

/**
 * Poll for job completion and get derivative URN
 */
async function pollForCompletion(
  token: string, 
  urn: string, 
  outputFormat: ApsOutputFormat,
  timeout: number,
  pollInterval: number
): Promise<string> {
  const startTime = Date.now();
  console.log('[APS] Polling for translation completion...');

  while (Date.now() - startTime < timeout) {
    const response = await fetch(`${MODEL_DERIVATIVE_URL}/${urn}/manifest`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ConversionError(`Failed to fetch manifest: ${response.status} ${errorText}`);
    }

    const manifest = await response.json() as {
      status: string;
      progress: string;
      derivatives?: Array<{
        outputType: string;
        status: string;
        children?: Array<{
          urn: string;
          role: string;
          mime: string;
          type: string;
        }>;
      }>;
    };

    console.log(`[APS] Status: ${manifest.status}, Progress: ${manifest.progress}`);

    if (manifest.status === 'success') {
      // Find the OBJ/STL derivative
      const derivative = manifest.derivatives?.find(d => d.outputType === outputFormat);
      if (derivative && derivative.children) {
        const outputFile = derivative.children.find(c => c.role.toUpperCase() === outputFormat.toUpperCase() || c.type === 'resource');
        if (outputFile) {
          console.log('[APS] Translation complete!');
          return outputFile.urn;
        }
      }
      throw new ConversionError('Translation succeeded but no output file found in manifest');
    }

    if (manifest.status === 'failed' || manifest.status === 'timeout') {
      throw new ConversionError(`Translation failed with status: ${manifest.status}`);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new TimeoutError(`Translation timed out after ${timeout}ms`);
}

/**
 * Download the converted file
 */
async function downloadDerivative(
  token: string,
  sourceUrn: string,
  derivativeUrn: string,
  outputPath: string
): Promise<void> {
  console.log(`[APS] Downloading converted file...`);
  console.log(`[APS] Source URN: ${sourceUrn}`);
  console.log(`[APS] Derivative URN: ${derivativeUrn}`);

  // First, try direct download (deprecated but still works in many cases)
  const directUrl = `${MODEL_DERIVATIVE_URL}/${sourceUrn}/manifest/${encodeURIComponent(derivativeUrn)}`;
  console.log(`[APS] Trying direct download: ${directUrl}`);
  
  const directResponse = await fetch(directUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (directResponse.ok) {
    const buffer = Buffer.from(await directResponse.arrayBuffer());
    await fs.writeFile(outputPath, buffer);
    console.log(`[APS] Downloaded directly to: ${outputPath} (${buffer.length} bytes)`);
    return;
  }

  console.log(`[APS] Direct download failed (${directResponse.status}), trying signed cookies...`);

  // Get signed download URL and cookies
  const cookiesUrl = `${MODEL_DERIVATIVE_URL}/${sourceUrn}/manifest/${encodeURIComponent(derivativeUrn)}/signedcookies`;
  console.log(`[APS] Fetching signed cookies from: ${cookiesUrl}`);
  
  const response = await fetch(cookiesUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ConversionError(`Failed to get signed cookies: ${response.status} ${errorText}`);
  }

  // Get cookies from response headers (Set-Cookie headers)
  const setCookieHeaders = response.headers.getSetCookie?.() || [];
  console.log(`[APS] Received ${setCookieHeaders.length} cookies`);

  const downloadData = await response.json() as { 
    url: string; 
    'content-type': string;
    etag: string;
    size: number;
  };
  
  console.log(`[APS] Download URL: ${downloadData.url}`);
  console.log(`[APS] File size: ${downloadData.size} bytes`);

  // Build cookie string from Set-Cookie headers
  const cookieString = setCookieHeaders
    .map(cookie => cookie.split(';')[0])
    .join('; ');
  
  // Download using the URL with cookies
  const fileResponse = await fetch(downloadData.url, {
    method: 'GET',
    headers: cookieString ? { 'Cookie': cookieString } : {}
  });

  if (!fileResponse.ok) {
    const errorBody = await fileResponse.text();
    throw new ConversionError(`Failed to download file from signed URL: ${fileResponse.status} ${errorBody}`);
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
  console.log(`[APS] Downloaded to: ${outputPath} (${buffer.length} bytes)`);
}

/**
 * Convert a CAD file using Autodesk APS Model Derivative API
 * 
 * For DXF files, this uses a two-step process:
 * 1. Translate DXF → SVF2 (Autodesk's streaming format)
 * 2. Extract OBJ geometry from SVF2
 * 
 * @param inputPath - Path to the input file (DWG, DXF, etc.)
 * @param outputPath - Path for the output file
 * @param options - Conversion options
 */
export async function apsConvert(
  inputPath: string,
  outputPath: string,
  options: ApsConversionOptions = {}
): Promise<string> {
  const { 
    outputFormat = 'obj',
    timeout = config.conversionTimeout * 6, // APS two-step process takes even longer
    pollInterval = 5000 // 5 seconds
  } = options;

  if (!isApsAvailable()) {
    throw new ConversionError('APS is not configured. Set APS_CLIENT_ID and APS_CLIENT_SECRET.');
  }

  const inputExt = path.extname(inputPath).toLowerCase();
  console.log(`[APS] Converting ${path.basename(inputPath)} to ${outputFormat}`);

  try {
    // 1. Get access token
    const token = await getAccessToken();

    // 2. Ensure bucket exists
    await ensureBucket(token, APS_BUCKET_KEY);

    // 3. Upload file
    const objectId = await uploadFile(token, APS_BUCKET_KEY, inputPath);

    // DXF files require two-step conversion: DXF → SVF2 → OBJ
    // because direct DXF → OBJ is not supported
    if (inputExt === '.dxf' && (outputFormat === 'obj' || outputFormat === 'stl')) {
      console.log('[APS] Using two-step conversion for DXF: SVF2 → OBJ');

      // Step 1: Translate to SVF2
      const urn = await createSvf2TranslationJob(token, objectId);
      
      // Step 2: Poll for SVF2 completion and get model GUID
      const modelGuid = await pollForSvf2Completion(
        token, urn, timeout / 2, pollInterval
      );
      
      // Step 3: Create OBJ extraction job with objectIds: [-1] (whole model)
      await createObjExtractionJob(token, urn, modelGuid);
      
      // Step 4: Poll for OBJ completion
      const derivativeUrn = await pollForCompletion(
        token, urn, outputFormat, timeout / 2, pollInterval
      );
      
      // Step 5: Download result
      await downloadDerivative(token, urn, derivativeUrn, outputPath);
    } else {
      // Direct translation for supported formats
      const urn = await createTranslationJob(token, objectId, outputFormat);
      const derivativeUrn = await pollForCompletion(token, urn, outputFormat, timeout, pollInterval);
      await downloadDerivative(token, urn, derivativeUrn, outputPath);
    }

    // Verify output
    if (await fs.pathExists(outputPath)) {
      const stats = await fs.stat(outputPath);
      if (stats.size > 0) {
        console.log(`[APS] Conversion successful: ${outputPath} (${stats.size} bytes)`);
        return outputPath;
      }
    }

    throw new ConversionError('APS conversion completed but output file is empty or missing');

  } catch (error) {
    if (error instanceof ConversionError || error instanceof TimeoutError) {
      throw error;
    }
    throw new ConversionError(`APS conversion failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if a file likely contains ACIS 3D solids (which require APS)
 */
export function likelyHasAcisSolids(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.dxf') return false;

  try {
    // Read first 10KB to check for ACIS indicators
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(10240);
    fs.readSync(fd, buffer, 0, 10240, 0);
    fs.closeSync(fd);

    const content = buffer.toString('utf8');
    
    // Check for ACIS solid indicators
    return content.includes('3DSOLID') || 
           content.includes('AcDb3dSolid') ||
           content.includes('ACIS');
  } catch {
    return false;
  }
}
