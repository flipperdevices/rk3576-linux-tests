#!/bin/bash

# RK3576 Board Test Suite
# Main script to orchestrate various system tests

# Default values
TEST_DURATION=60  # Default test duration in minutes
TEST_INTERVAL=0.5  # Default sampling interval in seconds
TEST_NAME=""  # Optional test name
AUTO_OPEN_REPORT=false  # Auto-open report when done
RUN_ALL=true
RUN_TEMPERATURE=false
RUN_POWER=false
RUN_CPU_STRESS=false
RUN_GPU=false
RUN_NETWORK=false
RUN_DISK=false

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Results directory with timestamp
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_DIR="results/test_run_${TIMESTAMP}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --all)
            RUN_ALL=true
            shift
            ;;
        --temperature)
            RUN_ALL=false
            RUN_TEMPERATURE=true
            shift
            ;;
        --power)
            RUN_ALL=false
            RUN_POWER=true
            shift
            ;;
        --cpu-stress)
            RUN_ALL=false
            RUN_CPU_STRESS=true
            shift
            ;;
        --gpu)
            RUN_ALL=false
            RUN_GPU=true
            shift
            ;;
        --network)
            RUN_ALL=false
            RUN_NETWORK=true
            shift
            ;;
        --disk)
            RUN_ALL=false
            RUN_DISK=true
            shift
            ;;
        --time)
            TEST_DURATION="$2"
            shift 2
            ;;
        --name)
            TEST_NAME="$2"
            shift 2
            ;;
        --interval)
            TEST_INTERVAL="$2"
            shift 2
            ;;
        --auto-report-open)
            AUTO_OPEN_REPORT=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  --all         Run all tests (default)"
            echo "  --temperature Run temperature monitoring test"
            echo "  --power       Run power consumption test"
            echo "  --cpu-stress  Run CPU stress test"
            echo "  --gpu         Run GPU performance test"
            echo "  --network     Run network performance test"
            echo "  --disk        Run disk I/O test"
            echo "  --time MIN    Set test duration in minutes (default: 60)"
            echo "  --name NAME   Set custom test name for report"
            echo "  --auto-report-open  Automatically open report when test completes"
            echo "  --interval SEC Set sampling interval in seconds (default: 0.5)"
            echo "  -h, --help    Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

# If --all is set or no specific test is selected, enable all tests
if [ "$RUN_ALL" = true ]; then
    RUN_TEMPERATURE=true
    RUN_POWER=true
    RUN_CPU_STRESS=true
    RUN_GPU=true
    RUN_NETWORK=true
    RUN_DISK=true
fi

# Function to log system information
log_system_info() {
    local info_file="${RESULTS_DIR}/system_info.txt"
    
    # Get board model
    local board_model="Unknown"
    if [ -f /proc/device-tree/model ]; then
        board_model=$(cat /proc/device-tree/model | tr -d '\0')
    fi
    
    # Get kernel version
    local kernel_version=$(uname -r)
    
    # Get hostname
    local hostname=$(hostname)
    
    # Display to stdout
    echo ""
    echo "Board Model: ${board_model}"
    echo "Hostname: ${hostname}"
    echo "Kernel Version: ${kernel_version}"
    echo ""
    echo ""
    echo "Test Started: $(date)"
    echo "Test Duration: ${TEST_DURATION} minutes"
    echo ""
    echo "=== Thermal Governor Policy ==="
    for i in 0 1 2 3 4 5; do
        zone_path="/sys/devices/virtual/thermal/thermal_zone${i}/policy"
        if [ -f "$zone_path" ]; then
            policy=$(cat "$zone_path" 2>/dev/null || echo "N/A")
            echo "thermal_zone${i}: ${policy}"
        fi
    done
    echo ""
    
    # Also save full info to file (silently)
    {
        echo "===== SYSTEM INFORMATION ====="
        echo "Test Started: $(date)"
        echo "Test Duration: ${TEST_DURATION} minutes"
        echo "Sampling Interval: ${TEST_INTERVAL} seconds"
        if [ -n "$TEST_NAME" ]; then
            echo "Test Name: ${TEST_NAME}"
        fi
        echo ""
        
        # Board name
        echo "=== Board Information ==="
        echo "Board Model: ${board_model}"
        echo ""
        
        # Hostname and kernel version
        echo "=== System Details ==="
        echo "Hostname: ${hostname}"
        echo "Kernel Version: ${kernel_version}"
        echo "Full Kernel Info: $(uname -a)"
        echo ""
        
        # Linux distribution info
        echo "=== Linux Distribution ==="
        if command -v lsb_release &> /dev/null; then
            lsb_release -a 2>/dev/null
        else
            if [ -f /etc/os-release ]; then
                cat /etc/os-release
            fi
        fi
        echo ""
        
        # Thermal governor information
        echo "=== Thermal Governor Policy ==="
        for zone in /sys/devices/virtual/thermal/thermal_zone*/; do
            if [ -f "${zone}policy" ]; then
                zone_name=$(basename "$zone")
                policy=$(cat "${zone}policy" 2>/dev/null || echo "N/A")
                echo "${zone_name}: ${policy}"
            fi
        done
        echo ""
        
        # CPU information
        echo "=== CPU Information ==="
        lscpu 2>/dev/null || echo "lscpu not available"
        echo ""
        
        # Memory information
        echo "=== Memory Information ==="
        free -h 2>/dev/null || echo "free command not available"
        echo ""
        
    } > "$info_file"
}

# Function to check dependencies
check_dependencies() {
    local missing_deps=()
    
    # Check for required commands
    command -v sensors &> /dev/null || missing_deps+=("lm-sensors")
    command -v python3 &> /dev/null || missing_deps+=("python3")
    
    # Check for Python packages
    python3 -c "import pandas" 2>/dev/null || missing_deps+=("python3-pandas")
    python3 -c "import plotly" 2>/dev/null || missing_deps+=("python3-plotly")
    
    if [ ${#missing_deps[@]} -gt 0 ]; then
        echo -e "${YELLOW}Warning: The following dependencies may be missing:${NC}"
        for dep in "${missing_deps[@]}"; do
            echo "  - $dep"
        done
        echo -e "${YELLOW}Some tests may not work properly.${NC}"
        echo ""
    fi
}

# Main execution
main() {
    echo -e "${GREEN}======================================${NC}"
    echo -e "${GREEN}RK3576 Board Test Suite${NC}"
    echo -e "${GREEN}======================================${NC}"
    echo ""
    
    # Create results directory
    mkdir -p "$RESULTS_DIR"
    echo -e "${GREEN}Results will be saved to: ${RESULTS_DIR}${NC}"
    echo ""
    
    # Check dependencies
    check_dependencies
    
    # Log system information
    log_system_info
    
    # Run selected tests
    echo -e "${GREEN}Running tests for ${TEST_DURATION} minutes...${NC}"
    echo ""
    
    # Start system monitoring first (in background)
    if [ "$RUN_TEMPERATURE" = true ]; then
        echo -e "${GREEN}Starting System Monitoring Test...${NC}"
        ./temperature/system_monitor.sh "$TEST_DURATION" "$RESULTS_DIR" "$TEST_INTERVAL" &
        MONITOR_PID=$!
    fi
    
    # Start CPU stress test in background (runs infinitely until killed)
    if [ "$RUN_CPU_STRESS" = true ]; then
        echo -e "${GREEN}Starting CPU Stress Test (background)...${NC}"
        ./cpu/cpu_test.sh "$RESULTS_DIR" &
        CPU_PID=$!
    fi
    
    # Start GPU monitoring and stress test in background
    if [ "$RUN_GPU" = true ]; then
        echo -e "${GREEN}Starting GPU Monitoring Test...${NC}"
        ./gpu/gpu_monitor.sh "$TEST_DURATION" "$RESULTS_DIR" "$TEST_INTERVAL" &
        GPU_MONITOR_PID=$!
        
        echo -e "${GREEN}Starting GPU Stress Test (background)...${NC}"
        ./gpu/gpu_test.sh "$RESULTS_DIR" "$TEST_DURATION" &
        GPU_STRESS_PID=$!
    fi
    
    if [ "$RUN_POWER" = true ]; then
        echo -e "${YELLOW}Power test not yet implemented (mock)${NC}"
        # ./power/power_test.sh "$TEST_DURATION" "$RESULTS_DIR"
    fi
    
    # Wait for system monitoring to complete
    if [ "$RUN_TEMPERATURE" = true ]; then
        wait $MONITOR_PID
    elif [ "$RUN_CPU_STRESS" = true ]; then
        # Nothing else is keeping time, so hold here for the requested duration.
        # cpu_test.sh runs stress-ng until the kill below, so without this the
        # stress test gets killed immediately after it starts.
        sleep $((TEST_DURATION * 60))
    fi
    
    # Kill CPU stress test when monitoring is done
    if [ "$RUN_CPU_STRESS" = true ]; then
        # Get stress-ng PID from marker file
        STRESS_NG_PID=$(grep "^PID=" "${RESULTS_DIR}/cpu_stress_marker.txt" 2>/dev/null | cut -d= -f2)
        if [ -n "$STRESS_NG_PID" ]; then
            echo "Stopping CPU stress test (PID: $STRESS_NG_PID)..."
            kill $STRESS_NG_PID 2>/dev/null
            kill $CPU_PID 2>/dev/null
        fi
        # Brief wait to let processes clean up
        sleep 1
    fi
    
    # Kill GPU tests when monitoring is done
    if [ "$RUN_GPU" = true ]; then
        # Wait for GPU monitoring to complete
        wait $GPU_MONITOR_PID 2>/dev/null
        
        # Get glmark2 PIDs from marker file and kill them
        GLMARK_PIDS=$(grep "^PID=" "${RESULTS_DIR}/gpu_stress_marker.txt" 2>/dev/null | cut -d= -f2)
        if [ -n "$GLMARK_PIDS" ]; then
            echo "Stopping GPU stress test processes..."
            for PID in $GLMARK_PIDS; do
                echo "  Killing PID: $PID"
                kill $PID 2>/dev/null
            done
            kill $GPU_STRESS_PID 2>/dev/null
        fi
        # Brief wait to let processes clean up
        sleep 1
    fi
    
    
    if [ "$RUN_NETWORK" = true ]; then
        echo -e "${YELLOW}Network test not yet implemented (mock)${NC}"
        # ./network/network_test.sh "$TEST_DURATION" "$RESULTS_DIR"
    fi
    
    if [ "$RUN_DISK" = true ]; then
        echo -e "${YELLOW}Disk test not yet implemented (mock)${NC}"
        # ./disk/disk_test.sh "$TEST_DURATION" "$RESULTS_DIR"
    fi
    
    echo ""
    
    # Generate combined HTML report (silently)
    python3 ./common/generate_combined_report.py "$RESULTS_DIR" > /dev/null 2>&1
    
    # Get full path for report
    FULL_PATH=$(cd "$(dirname "$RESULTS_DIR")" && pwd)/$(basename "$RESULTS_DIR")
    
    echo ""
    echo "======================================"
    if [ -f "${RESULTS_DIR}/report.html" ]; then
        echo "✅ All tests completed!"
        echo "Report generated: ${FULL_PATH}/report.html"
        
        # Auto-open report if requested
        if [ "$AUTO_OPEN_REPORT" = true ]; then
            echo "Opening report in browser..."
            
            # Get absolute path for the report
            REPORT_ABSOLUTE_PATH="${FULL_PATH}/report.html"
            
            # Simple approach - just try to open with available browser
            if command -v chromium &> /dev/null; then
                chromium "$REPORT_ABSOLUTE_PATH" 2>/dev/null &
                echo "Attempted to open in Chromium"
            elif command -v firefox &> /dev/null; then
                firefox "$REPORT_ABSOLUTE_PATH" 2>/dev/null &
                echo "Attempted to open in Firefox"
            elif command -v xdg-open &> /dev/null; then
                xdg-open "$REPORT_ABSOLUTE_PATH" 2>/dev/null &
                echo "Attempted to open with system default browser"
            else
                echo "No browser found to open report"
            fi
            
            echo "Note: Browser may not open when running from KDE desktop shortcuts"
            echo "Report saved at: $REPORT_ABSOLUTE_PATH"
        fi
    else
        echo "⚠️  All tests completed!"
        echo "Warning: Report generation failed"
    fi
    echo "======================================"
}

# Run main function
main
