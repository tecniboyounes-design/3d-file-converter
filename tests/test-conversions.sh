#!/usr/bin/env bash
# ============================================================
# 3D File Converter - Comprehensive Conversion Test Suite
# ============================================================
# Tests all conversion routes EXCEPT Autodesk APS (paid service).
#
# Usage:
#   bash tests/test-conversions.sh              # default: http://localhost:7008
#   bash tests/test-conversions.sh http://host:port
#
# Prerequisites:
#   docker compose up -d   (services must be running and healthy)
# ============================================================

set -euo pipefail

# ── Config ──────────────────────────────────────────────────
BASE_URL="${1:-http://localhost:7008}"
API_URL="${BASE_URL}/api"
TIMEOUT=300          # 5 min per conversion (some are slow)
TMPDIR_BASE=$(mktemp -d "${TMPDIR:-/tmp}/3d-test.XXXXXX")

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ── Counters ────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
TOTAL=0
declare -a RESULTS=()

# ── Cleanup ─────────────────────────────────────────────────
cleanup() {
  rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT

# ── Helpers ─────────────────────────────────────────────────
log()      { echo -e "${CYAN}[TEST]${RESET} $*"; }
log_pass() { echo -e "${GREEN}  PASS${RESET} $*"; }
log_fail() { echo -e "${RED}  FAIL${RESET} $*"; }
log_skip() { echo -e "${YELLOW}  SKIP${RESET} $*"; }
log_head() { echo -e "\n${BOLD}═══ $* ═══${RESET}"; }

# Convert a file via the API (with automatic retry on rate limit).
# Usage: convert_file <input_path> <output_format> <output_path>
# Returns 0 on success, 1 on failure.
convert_file() {
  local input_path="$1"
  local output_format="$2"
  local output_path="$3"
  local max_retries=5
  local attempt=0
  local http_code body response

  while true; do
    # Upload and convert
    response=$(curl -s -w "\n%{http_code}" \
      --max-time "$TIMEOUT" \
      -F "file=@${input_path}" \
      -F "format=${output_format}" \
      "${API_URL}/convert" 2>&1) || {
      echo "CURL_ERROR: $response" >&2
      return 1
    }

    http_code=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')

    # Handle rate limiting with automatic retry
    if [[ "$http_code" == "429" ]]; then
      attempt=$((attempt + 1))
      if [[ "$attempt" -gt "$max_retries" ]]; then
        echo "Rate limited after $max_retries retries" >&2
        return 1
      fi
      local wait_secs
      wait_secs=$(echo "$body" | grep -o '"retryAfter":[0-9]*' | cut -d: -f2)
      wait_secs=${wait_secs:-10}
      # Add a small buffer
      wait_secs=$((wait_secs + 2))
      printf "\r  %-22s ${DIM}(rate limited, waiting ${wait_secs}s...)${RESET}          " "" 2>/dev/null || true
      sleep "$wait_secs"
      continue
    fi

    break
  done

  if [[ "$http_code" != "200" ]]; then
    echo "HTTP $http_code: $body" >&2
    return 1
  fi

  # Extract download URL from JSON response
  local download_url
  download_url=$(echo "$body" | grep -o '"downloadUrl":"[^"]*"' | cut -d'"' -f4)
  if [[ -z "$download_url" ]]; then
    echo "No downloadUrl in response: $body" >&2
    return 1
  fi

  # Download the converted file
  local dl_code
  dl_code=$(curl -s -o "$output_path" -w "%{http_code}" \
    --max-time 60 \
    "${BASE_URL}${download_url}" 2>&1) || {
    echo "Download failed" >&2
    return 1
  }

  if [[ "$dl_code" != "200" ]]; then
    echo "Download HTTP $dl_code" >&2
    return 1
  fi

  # Verify output file exists and is non-empty
  if [[ ! -s "$output_path" ]]; then
    echo "Output file is empty" >&2
    return 1
  fi

  # Extract tool and duration from response
  local tool duration
  tool=$(echo "$body" | grep -o '"tool":"[^"]*"' | cut -d'"' -f4)
  duration=$(echo "$body" | grep -o '"duration":[0-9]*' | cut -d: -f2)
  echo "tool=${tool:-unknown} duration=${duration:-?}ms"
  return 0
}

# Run a single test case.
# Usage: run_test <route_name> <input_file> <output_format>
run_test() {
  local route="$1"
  local input_file="$2"
  local output_format="$3"
  local input_ext="${input_file##*.}"
  local test_name="${input_ext} -> ${output_format}"
  local output_file="${TMPDIR_BASE}/out_${input_ext}_to_${output_format}.${output_format}"

  TOTAL=$((TOTAL + 1))

  # Check input file exists
  if [[ ! -f "$input_file" ]]; then
    log_skip "$test_name (no ${input_ext} test file)"
    SKIP=$((SKIP + 1))
    RESULTS+=("SKIP|${route}|${test_name}|no input file")
    return
  fi

  printf "  %-22s " "${test_name}..."

  local result err_output
  err_output=$(mktemp)
  if result=$(convert_file "$input_file" "$output_format" "$output_file" 2>"$err_output"); then
    local size
    size=$(wc -c < "$output_file" | tr -d ' ')
    printf "\r  %-22s ${GREEN}PASS${RESET} ${DIM}(${result}, ${size} bytes)${RESET}\n" "${test_name}..."
    PASS=$((PASS + 1))
    RESULTS+=("PASS|${route}|${test_name}|${result}, ${size} bytes")
  else
    result=$(cat "$err_output")
    printf "\r  %-22s ${RED}FAIL${RESET} ${DIM}(${result})${RESET}\n" "${test_name}..."
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL|${route}|${test_name}|${result}")
  fi
  rm -f "$err_output"
}

# ============================================================
# PREFLIGHT: Health check
# ============================================================
log_head "Preflight"
log "Checking server health at ${BASE_URL}..."

health_response=$(curl -s --max-time 10 "${BASE_URL}/health" 2>&1) || {
  echo -e "${RED}Server not reachable at ${BASE_URL}${RESET}"
  echo "Make sure services are running: docker compose up -d"
  exit 1
}
log "Server is up: ${health_response}"

# ============================================================
# SEED: Create minimal OBJ cube test file
# ============================================================
log_head "Phase 1: Creating Seed Test Files"

SEED_OBJ="${TMPDIR_BASE}/cube.obj"
cat > "$SEED_OBJ" << 'OBJEOF'
# Simple cube for testing
mtllib cube.mtl
o Cube
v -1.0  1.0  1.0
v -1.0 -1.0  1.0
v -1.0  1.0 -1.0
v -1.0 -1.0 -1.0
v  1.0  1.0  1.0
v  1.0 -1.0  1.0
v  1.0  1.0 -1.0
v  1.0 -1.0 -1.0
vn -1.0  0.0  0.0
vn  0.0  0.0 -1.0
vn  1.0  0.0  0.0
vn  0.0  0.0  1.0
vn  0.0 -1.0  0.0
vn  0.0  1.0  0.0
f 1//1 2//1 4//1 3//1
f 3//2 4//2 8//2 7//2
f 7//3 8//3 6//3 5//3
f 5//4 6//4 2//4 1//4
f 3//5 7//5 5//5 1//5
f 8//5 4//5 2//5 6//5
OBJEOF

log "Created seed OBJ cube: $(wc -c < "$SEED_OBJ" | tr -d ' ') bytes"

# ── Generate test files in each format from the seed OBJ ────
# We need: stl, fbx, ply, gltf, glb, dae, 3ds, dxf, dwg, step, iges, ifc
SEED_FORMATS=(stl fbx ply gltf glb dae 3ds dxf dwg step iges ifc)

for fmt in "${SEED_FORMATS[@]}"; do
  target="${TMPDIR_BASE}/cube.${fmt}"
  printf "  Generating %-8s ... " "${fmt}"

  if result=$(convert_file "$SEED_OBJ" "$fmt" "$target" 2>&1); then
    local_size=$(wc -c < "$target" | tr -d ' ')
    echo -e "${GREEN}OK${RESET} ${DIM}(${local_size} bytes)${RESET}"
  else
    echo -e "${YELLOW}FAILED${RESET} ${DIM}(${result})${RESET}"
    echo -e "  ${DIM}Some tests using ${fmt} input will be skipped${RESET}"
  fi
done

echo ""
log "Seed files generated. Starting conversion tests..."

# ── Input file paths (shorthand) ───────────────────────────
F_OBJ="${TMPDIR_BASE}/cube.obj"
F_STL="${TMPDIR_BASE}/cube.stl"
F_FBX="${TMPDIR_BASE}/cube.fbx"
F_PLY="${TMPDIR_BASE}/cube.ply"
F_GLTF="${TMPDIR_BASE}/cube.gltf"
F_GLB="${TMPDIR_BASE}/cube.glb"
F_DAE="${TMPDIR_BASE}/cube.dae"
F_3DS="${TMPDIR_BASE}/cube.3ds"
F_DXF="${TMPDIR_BASE}/cube.dxf"
F_DWG="${TMPDIR_BASE}/cube.dwg"
F_STEP="${TMPDIR_BASE}/cube.step"
F_IGES="${TMPDIR_BASE}/cube.iges"
F_IFC="${TMPDIR_BASE}/cube.ifc"

# ============================================================
# Phase 2: Conversion Tests
# ============================================================

# ── Route 1: DXF <-> DWG (ODA) ─────────────────────────────
log_head "Route 1: DXF <-> DWG (ODA File Converter)"
run_test "ODA" "$F_DXF"  "dwg"
run_test "ODA" "$F_DWG"  "dxf"

# ── Route 2: Mesh -> DWG (Blender + ODA) ────────────────────
log_head "Route 2: Mesh -> DWG (Blender + ODA pipeline)"
run_test "Mesh->DWG" "$F_OBJ"  "dwg"
run_test "Mesh->DWG" "$F_STL"  "dwg"

# ── Route 3: DWG/DXF -> Mesh (ODA fallback) ─────────────────
log_head "Route 3: DWG/DXF -> Various (ODA fallback pipeline)"
run_test "DWG/DXF->Mesh" "$F_DWG"  "obj"
run_test "DWG/DXF->Mesh" "$F_DWG"  "glb"
run_test "DWG/DXF->Mesh" "$F_DWG"  "stl"
run_test "DWG/DXF->Mesh" "$F_DWG"  "step"
run_test "DWG/DXF->Mesh" "$F_DXF"  "obj"
run_test "DWG/DXF->Mesh" "$F_DXF"  "glb"

# ── Route 4: Any -> DXF (Blender) ───────────────────────────
log_head "Route 4: Any -> DXF (Blender)"
run_test "Any->DXF" "$F_OBJ"  "dxf"
run_test "Any->DXF" "$F_STL"  "dxf"
run_test "Any->DXF" "$F_GLB"  "dxf"

# ── Route 5a: STEP/IGES input (FreeCAD) ─────────────────────
log_head "Route 5a: STEP/IGES Input (FreeCAD-based)"
run_test "STEP->X" "$F_STEP"  "iges"
run_test "STEP->X" "$F_STEP"  "obj"
run_test "STEP->X" "$F_STEP"  "glb"
run_test "STEP->X" "$F_STEP"  "dxf"
run_test "STEP->X" "$F_STEP"  "dwg"
run_test "IGES->X" "$F_IGES"  "step"
run_test "IGES->X" "$F_IGES"  "obj"

# ── Route 5b: Mesh -> STEP/IGES (FreeCAD) ───────────────────
log_head "Route 5b: Mesh -> STEP/IGES (Blender + FreeCAD)"
run_test "Mesh->STEP" "$F_OBJ"  "step"
run_test "Mesh->STEP" "$F_STL"  "step"
run_test "Mesh->IGES" "$F_OBJ"  "iges"
run_test "Mesh->STEP" "$F_GLB"  "step"

# ── Route 6a: IFC input (IfcConvert) ────────────────────────
log_head "Route 6a: IFC Input (IfcOpenShell)"
run_test "IFC->X" "$F_IFC"  "obj"
run_test "IFC->X" "$F_IFC"  "glb"
run_test "IFC->X" "$F_IFC"  "dae"
run_test "IFC->X" "$F_IFC"  "step"
run_test "IFC->X" "$F_IFC"  "stl"

# ── Route 6b: Mesh -> IFC (mesh_to_ifc.py) ──────────────────
log_head "Route 6b: Mesh -> IFC (IfcOpenShell)"
run_test "Mesh->IFC" "$F_OBJ"  "ifc"
run_test "Mesh->IFC" "$F_STL"  "ifc"
run_test "Mesh->IFC" "$F_GLB"  "ifc"

# ── Route 7: Simple Mesh <-> Simple Mesh ────────────────────
log_head "Route 7: Simple Mesh <-> Simple Mesh (Assimp/Blender)"
run_test "Mesh<->Mesh" "$F_OBJ"  "stl"
run_test "Mesh<->Mesh" "$F_OBJ"  "glb"
run_test "Mesh<->Mesh" "$F_STL"  "obj"
run_test "Mesh<->Mesh" "$F_FBX"  "glb"
run_test "Mesh<->Mesh" "$F_GLB"  "obj"
run_test "Mesh<->Mesh" "$F_DAE"  "stl"
run_test "Mesh<->Mesh" "$F_PLY"  "obj"
run_test "Mesh<->Mesh" "$F_3DS"  "glb"

# ============================================================
# SUMMARY
# ============================================================
log_head "Test Results Summary"

echo ""
printf "${BOLD}%-8s %-20s %-22s %s${RESET}\n" "Status" "Route" "Conversion" "Details"
printf "%-8s %-20s %-22s %s\n" "------" "--------------------" "----------------------" "-------"

for entry in "${RESULTS[@]}"; do
  IFS='|' read -r status route test_name details <<< "$entry"
  case "$status" in
    PASS) color="$GREEN" ;;
    FAIL) color="$RED" ;;
    SKIP) color="$YELLOW" ;;
    *)    color="$RESET" ;;
  esac
  printf "${color}%-8s${RESET} %-20s %-22s ${DIM}%s${RESET}\n" "$status" "$route" "$test_name" "$details"
done

echo ""
echo -e "${BOLD}Total: ${TOTAL}${RESET} | ${GREEN}Passed: ${PASS}${RESET} | ${RED}Failed: ${FAIL}${RESET} | ${YELLOW}Skipped: ${SKIP}${RESET}"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "${RED}Some tests failed!${RESET}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${RESET}"
  exit 0
fi
