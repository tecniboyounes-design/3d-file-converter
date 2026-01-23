import React, { useState } from "react";

function App() {
  const [file, setFile] = useState(null);
  const [format, setFormat] = useState("glb");
  const [status, setStatus] = useState("idle"); // idle, uploading, converting, success, error
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isExiting, setIsExiting] = useState(false);

  // Clean up old files on app load (refresh/start)
  React.useEffect(() => {
    fetch("/api/cleanup", { method: "POST" }).catch(err =>
      console.error("Failed to cleanup on load:", err),
    );
  }, []);

  // Auto-dismiss toast notifications after 3 seconds
  React.useEffect(() => {
    if (status === "success" || status === "error") {
      setIsExiting(false); // Reset exit state on new status

      // Start exit animation slightly before removal
      const exitTimer = setTimeout(() => {
        setIsExiting(true);
      }, 2700); // 2.7s - start exit animation

      const removeTimer = setTimeout(() => {
        setStatus("idle");
        setIsExiting(false);
      }, 3000); // 3.0s - actually remove

      return () => {
        clearTimeout(exitTimer);
        clearTimeout(removeTimer);
      };
    }
  }, [status]);

  const handleFileChange = e => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setStatus("idle");
      setErrorMessage("");
      setDownloadUrl(null);
      setIsExiting(false);
    }
  };

  const handleDrop = e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
      setStatus("idle");
      setErrorMessage("");
      setDownloadUrl(null);
      setIsExiting(false);
    }
  };

  const handleDragOver = e => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleConvert = async () => {
    if (!file) {
      // If no file selected, trigger file input
      document.getElementById("fileInput").click();
      return;
    }

    setStatus("converting");
    setErrorMessage("");
    setIsExiting(false);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("format", format);

    try {
      const response = await fetch("/api/convert", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Conversion failed");
      }

      const data = await response.json();
      setDownloadUrl(data.downloadUrl);
      setStatus("success");
    } catch (error) {
      console.error(error);
      setStatus("error");
      setErrorMessage("Conversion failed. Please try again.");
    }
  };

  return (
    <div>
      {/* Toast Notifications */}
      <div className="toast-container">
        {status === "success" && (
          <div className={`toast toast-success ${isExiting ? "exit" : ""}`}>
            <div>
              <p className="toast-title">Conversion Successful!</p>
              <p className="toast-desc">Your file is ready to download.</p>
            </div>
          </div>
        )}
        {status === "error" && (
          <div className={`toast toast-error ${isExiting ? "exit" : ""}`}>
            <div>
              <p className="toast-title">Conversion Failed</p>
              <p className="toast-desc">{errorMessage}</p>
            </div>
          </div>
        )}
      </div>

      <h1 className="title">3D TECNIBO File Converter </h1>
      <p className="subtitle">Convert your 3D models to standard formats</p>

      <div className="glass-card">
        <div
          className={`drop-zone ${file ? "active" : ""}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => document.getElementById("fileInput").click()}
        >
          <input
            type="file"
            id="fileInput"
            style={{ display: "none" }}
            onChange={handleFileChange}
            accept=".obj,.fbx,.gltf,.glb,.dxf"
          />

          <div className="plus-icon-circle">+</div>

          {file ? (
            <div>
              <p className="drop-text" style={{ fontWeight: "bold" }}>
                {file.name}
              </p>
              <p className="drop-subtext">
                {(file.size / 1024 / 1024).toFixed(2)} MB • Ready to convert
              </p>
            </div>
          ) : (
            <div>
              <p className="drop-text">Drop files here</p>
            </div>
          )}
        </div>

        {/* Control Bar: Format Left, Buttons Right */}
        <div className="control-bar">
          <div className="input-group">
            <label
              style={{
                color: "#40513B",
                fontWeight: "bold",
                fontSize: "0.9rem",
                margin: 0, // Reset margin for flex layout
              }}
            >
              Target Format:
            </label>
            <select
              value={format}
              onChange={e => setFormat(e.target.value)}
              className="select-format"
              onClick={e => e.stopPropagation()}
            >
              <option value="glb">GLB (Binary glTF)</option>
              <option value="gltf">glTF (JSON)</option>
              <option value="obj">OBJ</option>
              <option value="fbx">FBX</option>
              <option value="dxf">DXF</option>
            </select>
          </div>

          <div className="btn-group">
            <button
              className="btn"
              onClick={handleConvert}
              disabled={!file || status === "converting"}
            >
              {status === "converting" ? (
                <span className="loader"></span>
              ) : null}
              {status === "converting" ? "Converting..." : "Convert Now"}
            </button>

            <a
              href={downloadUrl || "#"}
              className={`btn btn-download ${!downloadUrl ? "disabled" : ""}`}
              style={{
                pointerEvents: downloadUrl ? "auto" : "none",
                opacity: downloadUrl ? 1 : 0.6,
                textDecoration: "none",
              }}
              aria-disabled={!downloadUrl}
            >
              Download
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
