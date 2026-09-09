#!/bin/bash

# GPU stress test script using glmark2
# Runs glmark2 with benchmark and logs GPU info and FPS data

RESULTS_DIR=${1:-"results"}
TEST_DURATION=${2:-10}  # Duration in minutes, default 10

echo "Starting GPU stress test..."
echo "Duration: ${TEST_DURATION} minutes"
echo "Using glmark2 benchmark (4 concurrent processes)"

# Check if glmark2 is installed
if ! command -v glmark2 &> /dev/null; then
    echo "Error: glmark2 is not installed"
    echo "Please install it with: sudo apt-get install glmark2"
    exit 1
fi

# Check if yad is installed for countdown dialog
if ! command -v yad &> /dev/null; then
    echo "Warning: yad is not installed, countdown dialog will not be shown"
    echo "Install with: sudo apt-get install yad"
    YAD_AVAILABLE=false
else
    YAD_AVAILABLE=true
fi

# Create marker file to indicate GPU stress is running
mkdir -p "${RESULTS_DIR}"
echo "GPU_STRESS=RUNNING" > "${RESULTS_DIR}/gpu_stress_marker.txt"
echo "START_TIME=$(date '+%Y-%m-%d %H:%M:%S')" >> "${RESULTS_DIR}/gpu_stress_marker.txt"
echo "DURATION=INFINITE" >> "${RESULTS_DIR}/gpu_stress_marker.txt"

# Check X Windows status and get screen resolution
echo "" >> "${RESULTS_DIR}/gpu_stress.log"
echo "=== X Windows Information ===" >> "${RESULTS_DIR}/gpu_stress.log"

# Try different display values
for DISP in :0 :1 :0.0; do
    if DISPLAY=$DISP xdpyinfo &>/dev/null; then
        export DISPLAY=$DISP
        echo "X Windows is running on display $DISPLAY" | tee -a "${RESULTS_DIR}/gpu_stress.log"
        
        # Get screen resolution
        RESOLUTION=$(DISPLAY=$DISPLAY xdpyinfo | grep dimensions | awk '{print $2}')
        echo "Screen resolution: $RESOLUTION" | tee -a "${RESULTS_DIR}/gpu_stress.log"
        
        # Get more detailed screen info
        DISPLAY=$DISPLAY xrandr 2>/dev/null | grep -E "^[[:space:]]*[0-9]+x[0-9]+" | head -5 >> "${RESULTS_DIR}/gpu_stress.log"
        break
    fi
done

if [ -z "$DISPLAY" ]; then
    echo "Warning: X Windows not detected, trying display :0" | tee -a "${RESULTS_DIR}/gpu_stress.log"
    export DISPLAY=:0
fi

echo "" >> "${RESULTS_DIR}/gpu_stress.log"

# Start 4 concurrent glmark2 processes
echo "Starting 4 concurrent glmark2 processes..."
echo ""

PID_LIST=""

# Process 1: Main visible benchmark with annotation showing test duration
echo "Process 1: glmark2 with terrain benchmark and test duration title" | tee -a "${RESULTS_DIR}/gpu_stress.log"
glmark2 --run-forever --fullscreen --annotate -b "terrain:title=Test Duration ${TEST_DURATION} minutes:title-size=0.04" >> "${RESULTS_DIR}/gpu_stress.log" 2>&1 &
PID1=$!
PID_LIST="$PID1"
echo "  Started PID: $PID1"

# Process 2: Off-screen refract benchmark
GLMARK_CMD2="glmark2 --run-forever --fullscreen -b refract --off-screen"
echo "Process 2: $GLMARK_CMD2" | tee -a "${RESULTS_DIR}/gpu_stress.log"
$GLMARK_CMD2 >> "${RESULTS_DIR}/gpu_stress_p2.log" 2>&1 &
PID2=$!
PID_LIST="$PID_LIST $PID2"
echo "  Started PID: $PID2"

# Process 3: Off-screen refract benchmark
GLMARK_CMD3="glmark2 --run-forever --fullscreen -b refract --off-screen"
echo "Process 3: $GLMARK_CMD3" | tee -a "${RESULTS_DIR}/gpu_stress.log"
$GLMARK_CMD3 >> "${RESULTS_DIR}/gpu_stress_p3.log" 2>&1 &
PID3=$!
PID_LIST="$PID_LIST $PID3"
echo "  Started PID: $PID3"

# Process 4: Off-screen refract benchmark
GLMARK_CMD4="glmark2 --run-forever --fullscreen -b refract --off-screen"
echo "Process 4: $GLMARK_CMD4" | tee -a "${RESULTS_DIR}/gpu_stress.log"
$GLMARK_CMD4 >> "${RESULTS_DIR}/gpu_stress_p4.log" 2>&1 &
PID4=$!
PID_LIST="$PID_LIST $PID4"
echo "  Started PID: $PID4"

echo ""
echo "All 4 GPU stress processes started"
echo "PIDs: $PID_LIST"

# Update marker file with PIDs for the main script to kill later
echo "PID=${PID_LIST}" >> "${RESULTS_DIR}/gpu_stress_marker.txt"

# glmark2 exits straight away without a working GL context. Record that so the
# report doesn't count a test that never ran as a pass.
sleep 1
GPU_STRESS_ALIVE=false
for PID in $PID_LIST; do
    if kill -0 "$PID" 2>/dev/null; then
        GPU_STRESS_ALIVE=true
    fi
done
if [ "$GPU_STRESS_ALIVE" = false ]; then
    echo "STATUS=FAILED" >> "${RESULTS_DIR}/gpu_stress_marker.txt"
    echo "GPU stress processes exited immediately, see gpu_stress.log"
fi

# Show countdown dialog using yad if available
if [ "$YAD_AVAILABLE" = true ]; then
    # Calculate timeout in seconds
    TIMEOUT_SECONDS=$((TEST_DURATION * 60))
    
    # Show countdown in background
    yad --text="<span font='28'>GPU Test ends in ${TEST_DURATION} minutes...</span>" \
        --timeout=$TIMEOUT_SECONDS \
        --timeout-indicator=bottom \
        --undecorated \
        --center \
        --geometry=600x200 \
        --markup \
        --no-buttons \
        2>/dev/null &
    YAD_PID=$!
fi

# Wait for all glmark2 processes
for PID in $PID_LIST; do
    wait $PID 2>/dev/null
done

# Kill yad dialog if it's still running
if [ "$YAD_AVAILABLE" = true ] && [ -n "$YAD_PID" ]; then
    kill $YAD_PID 2>/dev/null
fi

exit 0