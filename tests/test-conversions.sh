#!/usr/bin/env bash
# ============================================================
# 3D File Converter - Full Any-to-Any Conversion Test Suite
# ============================================================
# Tests ALL format combinations (13 formats x 12 targets = 156 tests).
#
# Formats: OBJ, STL, FBX, PLY, GLTF, GLB, DAE, 3DS, DXF, DWG,
#          STEP, IGES, IFC
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

# All 13 unique formats (stp=step, igs=iges aliases excluded)
ALL_FORMATS=(obj stl fbx ply gltf glb dae 3ds dxf dwg step iges ifc)

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

# Format label (uppercase, special cases)
fmt_label() {
  local f="$1"
  case "$f" in
    gltf) echo "glTF" ;;
    glb)  echo "GLB" ;;
    3ds)  echo "3DS" ;;
    ifc)  echo "IFC" ;;
    *)    echo "$f" | tr '[:lower:]' '[:upper:]' ;;
  esac
}

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
      wait_secs=$((wait_secs + 2))
      printf "\r  %-30s ${DIM}(rate limited, waiting ${wait_secs}s...)${RESET}          " "" 2>/dev/null || true
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
# Usage: run_test <input_file> <output_format>
run_test() {
  local input_file="$1"
  local output_format="$2"
  local input_ext="${input_file##*.}"
  local test_name="$(fmt_label "$input_ext") -> $(fmt_label "$output_format")"
  local output_file="${TMPDIR_BASE}/out_${input_ext}_to_${output_format}.${output_format}"

  TOTAL=$((TOTAL + 1))

  # Check input file exists
  if [[ ! -f "$input_file" ]]; then
    log_skip "$test_name (no ${input_ext} test file)"
    SKIP=$((SKIP + 1))
    RESULTS+=("SKIP|${test_name}|no input file")
    return
  fi

  printf "  %-30s " "${test_name}..."

  local result err_output
  err_output=$(mktemp)
  if result=$(convert_file "$input_file" "$output_format" "$output_file" 2>"$err_output"); then
    local size
    size=$(wc -c < "$output_file" | tr -d ' ')
    printf "\r  %-30s ${GREEN}PASS${RESET} ${DIM}(${result}, ${size} bytes)${RESET}\n" "${test_name}"
    PASS=$((PASS + 1))
    RESULTS+=("PASS|${test_name}|${result}, ${size} bytes")
  else
    result=$(cat "$err_output")
    # Truncate long error messages for display
    if [[ ${#result} -gt 120 ]]; then
      result="${result:0:120}..."
    fi
    printf "\r  %-30s ${RED}FAIL${RESET} ${DIM}(${result})${RESET}\n" "${test_name}"
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL|${test_name}|${result}")
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
# PHASE 1: Create Seed Test Files
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

# Generate test files in each format from the seed OBJ
SEED_FORMATS=(stl fbx ply gltf glb dae 3ds dxf dwg step iges ifc)

for fmt in "${SEED_FORMATS[@]}"; do
  target="${TMPDIR_BASE}/cube.${fmt}"
  printf "  Generating %-8s ... " "$(fmt_label "$fmt")"

  if result=$(convert_file "$SEED_OBJ" "$fmt" "$target" 2>&1); then
    local_size=$(wc -c < "$target" | tr -d ' ')
    echo -e "${GREEN}OK${RESET} ${DIM}(${local_size} bytes)${RESET}"
  else
    echo -e "${YELLOW}FAILED${RESET} ${DIM}(${result})${RESET}"
    echo -e "  ${DIM}Tests using $(fmt_label "$fmt") as input will be skipped${RESET}"
  fi
done

echo ""
log "Seed files generated. Starting any-to-any conversion tests..."
log "Testing ${#ALL_FORMATS[@]} formats x $((${#ALL_FORMATS[@]} - 1)) targets = $(( ${#ALL_FORMATS[@]} * (${#ALL_FORMATS[@]} - 1) )) conversions"

# ============================================================
# PHASE 2: Any-to-Any Conversion Matrix
# ============================================================

for input_fmt in "${ALL_FORMATS[@]}"; do
  log_head "$(fmt_label "$input_fmt") -> All Formats"

  input_file="${TMPDIR_BASE}/cube.${input_fmt}"

  for output_fmt in "${ALL_FORMATS[@]}"; do
    # Skip same-to-same
    if [[ "$input_fmt" == "$output_fmt" ]]; then
      continue
    fi

    run_test "$input_file" "$output_fmt"
  done
done

# ============================================================
# SUMMARY
# ============================================================
log_head "Test Results Summary"

# Print grouped results
echo ""
printf "${BOLD}%-8s %-30s %s${RESET}\n" "Status" "Conversion" "Details"
printf "%-8s %-30s %s\n" "------" "------------------------------" "-------"

for entry in "${RESULTS[@]}"; do
  IFS='|' read -r status test_name details <<< "$entry"
  case "$status" in
    PASS) color="$GREEN" ;;
    FAIL) color="$RED" ;;
    SKIP) color="$YELLOW" ;;
    *)    color="$RESET" ;;
  esac
  printf "${color}%-8s${RESET} %-30s ${DIM}%s${RESET}\n" "$status" "$test_name" "$details"
done

echo ""
echo -e "${BOLD}Total: ${TOTAL}${RESET} | ${GREEN}Passed: ${PASS}${RESET} | ${RED}Failed: ${FAIL}${RESET} | ${YELLOW}Skipped: ${SKIP}${RESET}"

# Print pass rate
if [[ "$TOTAL" -gt 0 ]]; then
  non_skipped=$((TOTAL - SKIP))
  if [[ "$non_skipped" -gt 0 ]]; then
    rate=$(( PASS * 100 / non_skipped ))
    echo -e "${BOLD}Pass rate: ${rate}%${RESET} (${PASS}/${non_skipped} excluding skips)"
  fi
fi

echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "${RED}Some tests failed!${RESET}"

  # Print failure summary
  echo ""
  echo -e "${BOLD}Failed conversions:${RESET}"
  for entry in "${RESULTS[@]}"; do
    IFS='|' read -r status test_name details <<< "$entry"
    if [[ "$status" == "FAIL" ]]; then
      echo -e "  ${RED}x${RESET} ${test_name}"
    fi
  done

  exit 1
else
  echo -e "${GREEN}All tests passed!${RESET}"
  exit 0
fi
