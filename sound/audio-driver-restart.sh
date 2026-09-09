#!/bin/bash
#
# audio-driver-restart.sh — Recover NAU8822 codec after boot-time I2C probe failure
#
# The NAU8822 driver can fail during early boot with "Failed to issue reset: -6"
# (ENXIO) due to an I2C race condition — the codec chip isn't ready when the
# driver probes at ~0.6s into boot. This leaves the sound card absent from
# aplay -l. Unbinding and rebinding the driver resolves the issue without reboot.
#
# Must run as root.

set -euo pipefail

DRIVER_PATH="/sys/bus/i2c/drivers/nau8822"
DEVICE_ID="6-001a"
I2C_BUS=6
I2C_ADDR=0x1a

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[-]${NC} $*"; }

if [[ $EUID -ne 0 ]]; then
    err "This script must be run as root"
    exit 1
fi

# Check if NAU8822 card is already present
if aplay -l 2>/dev/null | grep -q "NAU8822"; then
    log "NAU8822 sound card is already present:"
    aplay -l | grep "NAU8822"
    echo
    warn "Driver appears to be working. Use --force to rebind anyway."
    [[ "${1:-}" == "--force" ]] || exit 0
fi

# Verify the chip is physically present on I2C
log "Checking I2C bus $I2C_BUS for device at $I2C_ADDR..."
if ! i2cget -y "$I2C_BUS" "$I2C_ADDR" 0x00 w >/dev/null 2>&1; then
    err "NAU8822 not responding on I2C bus $I2C_BUS at address $I2C_ADDR"
    err "Check hardware connections"
    exit 1
fi
log "NAU8822 chip detected on I2C"

# Check dmesg for the known failure
if dmesg | grep -q "nau8822.*Failed to issue reset"; then
    warn "Boot log shows NAU8822 probe failure (I2C race condition)"
fi

# Unbind if currently bound (even in failed state)
if [[ -e "$DRIVER_PATH/$DEVICE_ID" ]]; then
    log "Unbinding NAU8822 driver..."
    echo "$DEVICE_ID" > "$DRIVER_PATH/unbind"
    sleep 0.5
fi

# Rebind the driver
log "Binding NAU8822 driver..."
echo "$DEVICE_ID" > "$DRIVER_PATH/bind"
sleep 1

# Verify recovery
if aplay -l 2>/dev/null | grep -q "NAU8822"; then
    log "NAU8822 sound card recovered successfully:"
    aplay -l | grep "NAU8822"

    # Restart PipeWire to pick up the new card
    if command -v pipewire >/dev/null 2>&1; then
        log "Restarting PipeWire to detect new sound card..."
        if systemctl --user restart pipewire pipewire-pulse wireplumber 2>/dev/null; then
            sleep 1
            log "PipeWire restarted"
        else
            warn "Could not restart PipeWire. This script runs as root, so --user targets"
            warn "root's session rather than the desktop user's. Restart it from that user"
            warn "if the card is still missing there."
        fi
    fi
else
    err "NAU8822 sound card still not present after rebind"
    err "Check dmesg for details:"
    dmesg | tail -20
    exit 1
fi
