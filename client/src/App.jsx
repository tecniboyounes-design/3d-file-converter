import React, { useState } from "react";

function App() {
  const [file, setFile] = useState(null);
  const [format, setFormat] = useState("glb");
  const [status, setStatus] = useState("idle"); // idle, uploading, converting, success, error
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");

  // Clean up old files on app load (refresh/start)
  React.useEffect(() => {
    fetch("/api/cleanup", { method: "POST" }).catch(err =>
      console.error("Failed to cleanup on load:", err),
    );
  }, []);

  const handleFileChange = e => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setStatus("idle");
      setErrorMessage("");
      setDownloadUrl(null);
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
    }
  };

  const handleDragOver = e => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleConvert = async () => {
    if (!file) return;

    setStatus("converting");
    setErrorMessage("");

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
      setErrorMessage(
        "Conversion failed. Please check the file and try again.",
      );
    }
  };

  return (
    <div className="glass-card">
      <h1 className="title">3D Converter</h1>

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
          accept=".obj,.fbx,.gltf"
        />
        {file ? (
          <div>
            <p style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
              {file.name}
            </p>
            <p style={{ opacity: 0.7 }}>
              {(file.size / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
        ) : (
          <div>
            <p style={{ fontSize: "1.2rem", marginBottom: "0.5rem" }}>
              Drag & drop your 3D file here
            </p>
            <p style={{ opacity: 0.7 }}>or click to browse</p>
            <p style={{ fontSize: "0.8rem", marginTop: "1rem", opacity: 0.5 }}>
              Supported: .obj, .fbx, .gltf
            </p>
          </div>
        )}
      </div>

      <div className="input-group">
        <label
          htmlFor="format"
          style={{
            display: "block",
            marginBottom: "0.5rem",
            fontWeight: "500",
          }}
        >
          Convert to:
        </label>
        <select
          id="format"
          value={format}
          onChange={e => setFormat(e.target.value)}
          className="select-format"
        >
          {/* Removed glb from dropdown as requested, wait no, user said "delete files or folders that we no longer need or glb" 
              Actually the user said "or glb". This is ambiguous. 
              "delete files or folders that we no longer need or glb"
              Did they mean "delete ... OR glb"?
              Or "delete ... FOR glb"?
              Given the context of "handle this formats... Output formats: obj, fbx, gltf, glb, dxf" in the FIRST prompt, 
              and the current prompt is a bit typo-heavy ("dekete", "strecture", "front and and backend"),
              "or glb" might be a typo for "for glb" or just referring to the glb output.
              However, I will keep GLB as it was a core requirement initially. 
              Wait, rereading: "delete files or folders that we no longer need or glb thank you"
              Maybe they want to REMOVE glb support? 
              Reflecting on: "Output formats: obj, fbx, gltf, glb, dxf" (First request)
              I will assume "or glb" was a typo or a cutoff thought, given the "thank you" right after.
              I will stick to the original requirement unless clarification is obvious. 
              Actually, let's keep it safe and support everything as before.
          */}
          <option value="glb">GLB (Binary glTF)</option>
          <option value="gltf">glTF (JSON)</option>
          <option value="obj">OBJ</option>
          <option value="fbx">FBX</option>
          <option value="dxf">DXF</option>
        </select>
      </div>

      <button
        className="btn"
        style={{ width: "100%" }}
        onClick={handleConvert}
        disabled={!file || status === "converting"}
      >
        {status === "converting" ? (
          <>
            <span className="loader"></span> Converting...
          </>
        ) : (
          "Convert File"
        )}
      </button>

      {status === "success" && downloadUrl && (
        <div
          className="status-message"
          style={{ color: "var(--success-color)" }}
        >
          <p style={{ marginBottom: "1rem" }}>Conversion successful!</p>
          <a
            href={downloadUrl}
            className="btn"
            style={{
              display: "inline-block",
              backgroundColor: "var(--success-color)",
              textDecoration: "none",
            }}
          >
            Download {format.toUpperCase()}
          </a>
        </div>
      )}

      {status === "error" && (
        <div className="status-message" style={{ color: "var(--error-color)" }}>
          {errorMessage}
        </div>
      )}
    </div>
  );
}

export default App;
