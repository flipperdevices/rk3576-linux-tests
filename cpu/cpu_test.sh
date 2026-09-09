#!/bin/bash

# CPU stress test script - runs in background during system monitoring
# Simply runs stress-ng for the specified duration

RESULTS_DIR=${1:-"results"}

echo "Starting CPU stress test in background..."
echo "Duration: Infinite (until killed by main script)"
echo "Loading all CPU cores..."

# Check if stress-ng is installed
if ! command -v stress-ng &> /dev/null; then
    echo "Error: stress-ng is not installed"
    echo "Please install it with: sudo apt-get install stress-ng"
    exit 1
fi

# Create marker file to indicate CPU stress is running
mkdir -p "${RESULTS_DIR}"
echo "CPU_STRESS=RUNNING" > "${RESULTS_DIR}/cpu_stress_marker.txt"
echo "START_TIME=$(date '+%Y-%m-%d %H:%M:%S')" >> "${RESULTS_DIR}/cpu_stress_marker.txt"
echo "DURATION=INFINITE" >> "${RESULTS_DIR}/cpu_stress_marker.txt"

# Run stress-ng infinitely in background - will be killed by main script
# --cpu 0 means use all available CPUs
# --timeout 0 or no timeout means run forever
STRESS_CMD="stress-ng --cpu 0 --metrics-brief"
echo "Executing command: $STRESS_CMD"
echo ""

$STRESS_CMD > "${RESULTS_DIR}/cpu_stress.log" 2>&1 &
STRESS_PID=$!

echo "CPU stress test started (PID: $STRESS_PID)"

# Update marker file with PID for the main script to kill later
echo "PID=${STRESS_PID}" >> "${RESULTS_DIR}/cpu_stress_marker.txt"

# stress-ng can exit straight away (unsupported option, cgroup limit, no memory).
# Record that so the report doesn't count a test that never ran as a pass.
sleep 1
if ! kill -0 "${STRESS_PID}" 2>/dev/null; then
    echo "STATUS=FAILED" >> "${RESULTS_DIR}/cpu_stress_marker.txt"
    echo "CPU stress test exited immediately, see cpu_stress.log"
fi

# Keep running until killed by main script
wait $STRESS_PID 2>/dev/null

exit 0