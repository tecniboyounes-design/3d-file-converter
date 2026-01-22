const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs-extra");

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// Ensure upload directory exists (relative to root where script is run)
const UPLOAD_DIR = path.join(process.cwd(), "data", "uploads");
fs.ensureDirSync(UPLOAD_DIR);

// ==========================================
// STARTUP CLEANUP
// ==========================================
// Clear all files in uploads directory on server start
function clearUploadsOnStart() {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return console.error("Startup Cleanup Error:", err);
    files.forEach(file => {
      if (file === ".keep") return;
      fs.unlink(path.join(UPLOAD_DIR, file), err => {
        if (err) console.error(`Failed to delete ${file} on startup`);
      });
    });
    console.log("Startup: Cleaned previous temporary files.");
  });
}
clearUploadsOnStart();

// ==========================================
// PERIODIC CLEANUP TASK
// ==========================================
// Check every 1 minute and delete files older than 2 minutes
const CLEANUP_INTERVAL = 1 * 60 * 1000;
const FILE_AGE_LIMIT = 2 * 60 * 1000;

setInterval(() => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) {
      console.error("Cleanup Error: Unable to scan directory:", err);
      return;
    }

    files.forEach(file => {
      const filePath = path.join(UPLOAD_DIR, file);

      // Skip .gitkeep or other config files if present (though we cleared them)
      if (file === ".keep") return;

      fs.stat(filePath, (statErr, stats) => {
        if (statErr) {
          // If file is gone, ignore
          return;
        }

        if (Date.now() - stats.birthtime.getTime() > FILE_AGE_LIMIT) {
          fs.unlink(filePath, unlinkErr => {
            if (unlinkErr)
              console.error("Cleanup Error: Failed to delete file:", unlinkErr);
            else console.log(`Auto-Cleanup: Deleted orphaned file ${file}`);
          });
        }
      });
    });
  });
}, CLEANUP_INTERVAL);

// Configure storage
const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename(req, file, cb) {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

app.get("/", (req, res) => {
  res.send("3D Converter API is running");
});

app.post("/api/cleanup", (req, res) => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) {
      console.error("Manual Cleanup Error:", err);
      return res.status(500).json({ error: "Failed to cleanup" });
    }
    files.forEach(file => {
      if (file === ".keep") return;
      fs.unlink(path.join(UPLOAD_DIR, file), () => {});
    });
    console.log("Manual Cleanup: Wiped uploads directory.");
    res.json({ message: "Cleanup successful" });
  });
});

app.post("/api/convert", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).send("No file uploaded.");
  }

  // 0. CLEANUP OTHER FILES (Aggressive "New Conversion" Cleanup)
  // Delete everything in uploads that isn't the file we just uploaded
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    files.forEach(file => {
      if (file === ".keep") return;
      if (file === req.file.filename) return; // Don't delete the current file

      fs.unlink(path.join(UPLOAD_DIR, file), err => {
        if (err)
          console.error(
            `Warning: Failed to delete stale file ${file} during new conversion`,
          );
      });
    });
  } catch (err) {
    console.error("Error during pre-convert cleanup:", err);
  }

  const targetFormat = req.body.format || "glb";

  const inputFilename = req.file.filename;
  const outputFilename = `${path.basename(inputFilename, path.extname(inputFilename))}.${targetFormat}`;

  // Paths as seen inside the docker container
  const containerInputPath = `data/uploads/${inputFilename}`;
  const containerOutputPath = `data/uploads/${outputFilename}`;

  const command = `docker exec -i app node scripts/node.js/export.js -i ${containerInputPath} -o ${containerOutputPath}`;

  console.log(`Executing: ${command}`);

  exec(command, (error, stdout, stderr) => {
    // Determine input path for deletion
    const localInputPath = path.join(UPLOAD_DIR, inputFilename);

    if (error) {
      console.error(`exec error: ${error}`);

      // 1. DELETE INPUT FILE ON ERROR
      fs.unlink(localInputPath, err => {
        if (err)
          console.error(
            `Warning: Failed to delete input file ${inputFilename} after error:`,
            err,
          );
      });

      return res
        .status(500)
        .json({ error: "Conversion failed", details: stderr || error.message });
    }

    console.log(`stdout: ${stdout}`);
    console.error(`stderr: ${stderr}`);

    // Check if output file exists on host
    const localOutputPath = path.join(UPLOAD_DIR, outputFilename);

    if (fs.existsSync(localOutputPath)) {
      // 2. DELETE INPUT FILE immediately after successful conversion
      fs.unlink(localInputPath, err => {
        if (err)
          console.error(
            `Warning: Failed to delete input file ${inputFilename}:`,
            err,
          );
        else console.log(`Deleted input file: ${inputFilename}`);
      });

      res.json({
        message: "Conversion successful",
        downloadUrl: `/api/download/${outputFilename}`,
      });
    } else {
      // If conversion reported success but file is missing (rare), still cleanup input
      fs.unlink(localInputPath, err => {
        if (err)
          console.error(
            `Warning: Failed to delete input file ${inputFilename}:`,
            err,
          );
      });
      res.status(500).json({ error: "Output file not found after conversion" });
    }
  });
});

app.get("/api/download/:filename", (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(UPLOAD_DIR, filename);

  if (fs.existsSync(filePath)) {
    // 3. DELETE OUTPUT FILE after download
    res.download(filePath, err => {
      if (err) {
        console.error(`Error sending file: ${err}`);
      }

      fs.unlink(filePath, unlinkErr => {
        if (unlinkErr)
          console.error(
            `Warning: Failed to delete output file ${filename}:`,
            unlinkErr,
          );
        else console.log(`Deleted output file: ${filename}`);
      });
    });
  } else {
    res.status(404).send("File not found");
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log("Cleanup task scheduled (every 5 mins).");
});
