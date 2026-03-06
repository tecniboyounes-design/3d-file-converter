import React, { useState, useEffect, useCallback } from "react";

// API base URL - uses environment variable or defaults to same origin
const API_URL = import.meta.env.VITE_API_URL || "";

const SUPPORTED_FORMATS = [
  "glb",
  "gltf",
  "obj",
  "stl",
  "fbx",
  "ply",
  "dae",
  "3ds",
  "dxf",
  "dwg",
  "step",
  "stp",
  "iges",
  "igs",
  "ifc",
];

const MAX_FILES = 100;

// Generate unique ID for files
const generateId = () => Math.random().toString(36).substr(2, 9);

// Get file extension
const getExtension = (filename) => filename.split(".").pop().toLowerCase();

// Format file size
const formatSize = (bytes) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
};

function App() {
  // Global format (applied to new uploads)
  const [globalFormat, setGlobalFormat] = useState("glb");
  
  // File queue
  const [files, setFiles] = useState([]);
  
  // Batch job state
  const [jobId, setJobId] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Toast state
  const [toast, setToast] = useState(null);
  const [isExiting, setIsExiting] = useState(false);

  // Check if any file has input=output format conflict
  const hasFormatConflict = files.some(
    f => f.inputFormat === f.outputFormat && f.status === "pending"
  );

  // Check if any file has an error (blocks new conversions until removed)
  const hasErrorFiles = files.some(f => f.status === "error");

  // Collect all uploaded input extensions (for global format filtering)
  const uploadedExtensions = [...new Set(files.map(f => f.inputFormat))];

  // Check if all files are completed
  const allCompleted = files.length > 0 && files.every(
    f => f.status === "completed" || f.status === "error"
  );

  // Count completed files
  const completedCount = files.filter(f => f.status === "completed").length;

  // Auto-switch global format if current selection matches an uploaded extension
  useEffect(() => {
    if (files.length > 0 && uploadedExtensions.includes(globalFormat)) {
      const available = SUPPORTED_FORMATS.filter(fmt => !uploadedExtensions.includes(fmt));
      if (available.length > 0) {
        setGlobalFormat(available[0]);
      }
    }
  }, [uploadedExtensions.join(","), files.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync global format when all pending files share the same output format
  useEffect(() => {
    const pendingFiles = files.filter(f => f.status === "pending");
    if (pendingFiles.length === 0) return;
    const formats = new Set(pendingFiles.map(f => f.outputFormat));
    if (formats.size === 1) {
      const common = [...formats][0];
      if (common !== globalFormat) {
        setGlobalFormat(common);
      }
    }
  }, [files]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      setIsExiting(false);
      const exitTimer = setTimeout(() => setIsExiting(true), 3700);
      const removeTimer = setTimeout(() => {
        setToast(null);
        setIsExiting(false);
      }, 4000);
      return () => {
        clearTimeout(exitTimer);
        clearTimeout(removeTimer);
      };
    }
  }, [toast]);

  // Poll for job status
  useEffect(() => {
    if (!jobId || !isProcessing) return;

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`${API_URL}/api/convert/batch/${jobId}/status`);
        if (!response.ok) throw new Error("Failed to get status");
        
        const data = await response.json();
        
        // Update files with status from server
        setFiles(prevFiles => prevFiles.map(f => {
          const serverFile = data.files.find(sf => sf.id === f.id);
          if (serverFile) {
            return {
              ...f,
              status: serverFile.status,
              downloadUrl: serverFile.downloadUrl,
              error: serverFile.error,
              tool: serverFile.tool,
              duration: serverFile.duration,
            };
          }
          return f;
        }));

        // Check if processing is complete
        if (!data.isProcessing && data.completedCount === data.totalCount) {
          setIsProcessing(false);
          const errorCount = data.files.filter(f => f.status === "error").length;
          const successCount = data.files.filter(f => f.status === "completed").length;
          
          if (errorCount === 0) {
            setToast({ type: "success", title: "Batch Complete!", desc: `All ${successCount} files converted successfully.` });
          } else if (successCount > 0) {
            setToast({ type: "success", title: "Batch Complete", desc: `${successCount} succeeded, ${errorCount} failed.` });
          } else {
            setToast({ type: "error", title: "Batch Failed", desc: `All ${errorCount} files failed to convert.` });
          }
        }
      } catch (error) {
        console.error("Polling error:", error);
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [jobId, isProcessing]);

  // Handle new files (from input or drop)
  const handleNewFiles = useCallback((fileList) => {
    const newFiles = [];
    
    for (let i = 0; i < fileList.length && files.length + newFiles.length < MAX_FILES; i++) {
      const file = fileList[i];
      const inputFormat = getExtension(file.name);
      
      // Skip unsupported formats
      if (!SUPPORTED_FORMATS.includes(inputFormat)) {
        console.warn(`Skipping unsupported file: ${file.name}`);
        continue;
      }

      // Collect all extensions that will be in the queue after this batch
      const allInputExtensions = [
        ...new Set([
          ...files.map(f => f.inputFormat),
          ...newFiles.map(f => f.inputFormat),
          inputFormat,
        ]),
      ];

      // Determine output format (avoid same as input and any uploaded extension)
      let outputFormat = globalFormat;
      if (allInputExtensions.includes(outputFormat)) {
        const available = SUPPORTED_FORMATS.filter(fmt => !allInputExtensions.includes(fmt));
        outputFormat = available.length > 0 ? available[0] : SUPPORTED_FORMATS[0];
      }

      newFiles.push({
        id: generateId(),
        file,
        name: file.name,
        size: file.size,
        inputFormat,
        outputFormat,
        status: "pending",
        downloadUrl: null,
        error: null,
        tool: null,
        duration: null,
      });
    }

    if (newFiles.length > 0) {
      setFiles(prev => [...prev, ...newFiles]);
      setJobId(null); // Reset job when new files added
    }
  }, [files.length, globalFormat]);

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleNewFiles(e.target.files);
      e.target.value = ""; // Reset input
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleNewFiles(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // Update single file's output format
  const updateFileFormat = (fileId, newFormat) => {
    setFiles(prev => {
      const updated = prev.map(f =>
        f.id === fileId ? { ...f, outputFormat: newFormat } : f
      );
      return updated;
    });
  };

  // Remove file from queue
  const removeFile = (fileId) => {
    setFiles(prev => prev.filter(f => f.id !== fileId));
  };

  // Clear all files
  const clearAll = () => {
    setFiles([]);
    setJobId(null);
    setIsProcessing(false);
  };

  // Apply global format to all pending files
  const applyGlobalFormat = (newFormat) => {
    setGlobalFormat(newFormat);
    setFiles(prev => prev.map(f => {
      if (f.status !== "pending") return f;
      // Avoid same input/output
      if (f.inputFormat === newFormat) return f;
      return { ...f, outputFormat: newFormat };
    }));
  };

  // Start batch conversion
  const handleConvertAll = async () => {
    if (files.length === 0 || hasFormatConflict || isProcessing || hasErrorFiles) return;

    setIsProcessing(true);

    const formData = new FormData();
    formData.append("defaultFormat", globalFormat);

    // Build format overrides keyed by file index (matches server processing order)
    const formatOverrides = {};
    let fileIndex = 0;
    files.forEach(f => {
      if (f.status === "pending") {
        formData.append("file", f.file);
        formatOverrides[fileIndex] = f.outputFormat;
        fileIndex++;
      }
    });
    formData.append("formats", JSON.stringify(formatOverrides));

    try {
      const response = await fetch(`${API_URL}/api/convert/batch`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Batch upload failed");
      }

      setJobId(data.jobId);

      // Update file IDs to match server-assigned IDs
      setFiles(prev => {
        const serverFiles = data.files;
        let serverIdx = 0;
        return prev.map(f => {
          if (f.status === "pending" && serverIdx < serverFiles.length) {
            const sf = serverFiles[serverIdx++];
            return { ...f, id: sf.id, status: "pending" };
          }
          return f;
        });
      });

      setToast({ type: "success", title: "Batch Started", desc: `Converting ${data.totalFiles} files...` });
    } catch (error) {
      console.error(error);
      setIsProcessing(false);
      setToast({ type: "error", title: "Upload Failed", desc: error.message });
    }
  };

  // Download all as ZIP
  const handleDownloadAll = () => {
    if (!jobId || !allCompleted) return;
    window.open(`${API_URL}/api/convert/batch/${jobId}/download-all`, "_blank");
  };

  // Tool badge helper
  const getToolBadge = (tool) => {
    const badges = {
      assimp: { label: "⚡ Assimp", color: "#10b981" },
      blender: { label: "🎨 Blender", color: "#3b82f6" },
      oda: { label: "📐 ODA", color: "#8b5cf6" },
      pipeline: { label: "🔗 Pipeline", color: "#f59e0b" },
    };
    return badges[tool] || { label: tool, color: "#6b7280" };
  };

  // Status badge helper
  const getStatusBadge = (status) => {
    const badges = {
      pending: { label: "Pending", color: "#6b7280", bg: "#f3f4f6" },
      converting: { label: "Converting...", color: "#3b82f6", bg: "#dbeafe" },
      completed: { label: "Done", color: "#10b981", bg: "#d1fae5" },
      error: { label: "Failed", color: "#ef4444", bg: "#fee2e2" },
    };
    return badges[status] || badges.pending;
  };

  return (
    <div>
      {/* Toast Notifications */}
      <div className="toast-container">
        {toast && (
          <div className={`toast toast-${toast.type} ${isExiting ? "exit" : ""}`}>
            <div>
              <p className="toast-title">{toast.title}</p>
              <p className="toast-desc">{toast.desc}</p>
            </div>
          </div>
        )}
      </div>

      <h1 className="title">3D File Converter</h1>
      <p className="subtitle">Convert multiple 3D files at once</p>

      <div className="glass-card">
        {/* Drop Zone */}
        <div
          className={`drop-zone ${files.length > 0 ? "compact" : ""}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => document.getElementById("fileInput").click()}
        >
          <input
            type="file"
            id="fileInput"
            style={{ display: "none" }}
            onChange={handleFileChange}
            accept=".obj,.stl,.fbx,.ply,.gltf,.glb,.dae,.3ds,.dxf,.dwg,.step,.stp,.iges,.igs,.ifc"
            multiple
          />

          <div className="plus-icon-circle">+</div>

          <div>
            <p className="drop-text">
              {files.length > 0 ? "Add more files" : "Drop files here"}
            </p>
            <p className="drop-subtext">
              {files.length > 0 
                ? `${files.length} file${files.length > 1 ? "s" : ""} in queue (max ${MAX_FILES})`
                : "OBJ, STL, FBX, PLY, GLTF, GLB, DAE, 3DS, DXF, DWG, STEP, STP, IGES, IGS, IFC"
              }
            </p>
          </div>
        </div>

        {/* File Queue */}
        {files.length > 0 && (
          <div className="file-queue">
            <div className="queue-header">
              <h3 style={{ margin: 0, color: "var(--color-dark-green)" }}>
                Files ({files.length})
              </h3>
              <button 
                className="btn-text" 
                onClick={clearAll}
                disabled={isProcessing}
              >
                Clear All
              </button>
            </div>

            <div className="queue-list">
              {files.map((f) => {
                const hasConflict = f.inputFormat === f.outputFormat && f.status === "pending";
                const statusBadge = getStatusBadge(f.status);
                
                return (
                  <div 
                    key={f.id} 
                    className={`queue-item ${hasConflict ? "conflict" : ""} ${f.status}`}
                  >
                    <div className="queue-item-info">
                      <span className="file-name">{f.name}</span>
                      <span className="file-meta">
                        {formatSize(f.size)} • {f.inputFormat.toUpperCase()}
                      </span>
                    </div>

                    <div className="queue-item-format">
                      <span className="format-arrow">→</span>
                      <select
                        value={f.outputFormat}
                        onChange={(e) => updateFileFormat(f.id, e.target.value)}
                        disabled={f.status !== "pending" || isProcessing}
                        className={`select-mini ${hasConflict ? "error" : ""}`}
                      >
                        {SUPPORTED_FORMATS.filter(fmt => fmt !== f.inputFormat).map((fmt) => (
                          <option key={fmt} value={fmt}>
                            {fmt.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="queue-item-status">
                      <span 
                        className="status-badge"
                        style={{ 
                          color: statusBadge.color, 
                          background: statusBadge.bg 
                        }}
                      >
                        {f.status === "converting" && <span className="loader-mini"></span>}
                        {statusBadge.label}
                      </span>
                      
                      {f.tool && (
                        <span 
                          className="tool-badge"
                          style={{ background: getToolBadge(f.tool).color }}
                        >
                          {getToolBadge(f.tool).label}
                        </span>
                      )}
                    </div>

                    <div className="queue-item-actions">
                      {f.status === "completed" && f.downloadUrl && (
                        <a 
                          href={`${API_URL}${f.downloadUrl}`}
                          className="btn-icon download"
                          title="Download"
                        >
                          ↓
                        </a>
                      )}
                      
                      {f.status === "error" && (
                        <span className="error-hint" title={f.error}>
                          ⚠
                        </span>
                      )}
                      
                      {(f.status === "pending" && !isProcessing) && (
                        <button 
                          className="btn-icon remove"
                          onClick={() => removeFile(f.id)}
                          title="Remove"
                        >
                          ×
                        </button>
                      )}

                      {f.status === "error" && (
                        <button 
                          className="btn-icon remove"
                          onClick={() => removeFile(f.id)}
                          title="Remove failed file"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {hasFormatConflict && (
              <p className="conflict-warning">
                ⚠ Some files have the same input and output format. Please change the output format.
              </p>
            )}

            {hasErrorFiles && !isProcessing && (
              <p className="conflict-warning">
                ⚠ Remove failed files before starting a new conversion.
              </p>
            )}
          </div>
        )}

        {/* Control Bar */}
        <div className="control-bar">
          <div className="input-group">
            <label style={{ color: "#40513B", fontWeight: "bold", fontSize: "0.9rem", margin: 0 }}>
              Default Format:
            </label>
            <select
              value={globalFormat}
              onChange={(e) => applyGlobalFormat(e.target.value)}
              className="select-format"
              disabled={isProcessing}
            >
              <optgroup label="Mesh Formats">
                {["glb","gltf","obj","stl","fbx","ply","dae","3ds"].filter(fmt => !uploadedExtensions.includes(fmt)).map(fmt => (
                  <option key={fmt} value={fmt}>{fmt === "gltf" ? "glTF" : fmt.toUpperCase()}</option>
                ))}
              </optgroup>
              <optgroup label="CAD Formats">
                {["dxf","dwg","step","stp","iges","igs"].filter(fmt => !uploadedExtensions.includes(fmt)).map(fmt => (
                  <option key={fmt} value={fmt}>{fmt.toUpperCase()}</option>
                ))}
              </optgroup>
              <optgroup label="BIM Formats">
                {["ifc"].filter(fmt => !uploadedExtensions.includes(fmt)).map(fmt => (
                  <option key={fmt} value={fmt}>{fmt.toUpperCase()}</option>
                ))}
              </optgroup>
            </select>
          </div>

          <div className="btn-group">
            <button
              className="btn"
              onClick={handleConvertAll}
              disabled={files.length === 0 || hasFormatConflict || isProcessing || hasErrorFiles}
            >
              {isProcessing && <span className="loader"></span>}
              {isProcessing 
                ? `Converting ${completedCount}/${files.length}...` 
                : "Convert All"
              }
            </button>

            <button
              className={`btn btn-download ${!allCompleted ? "disabled" : ""}`}
              onClick={handleDownloadAll}
              disabled={!allCompleted || completedCount === 0}
            >
              Download All (ZIP)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
