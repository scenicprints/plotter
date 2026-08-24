# CR-6 SE Pen Plotter - staging repo

Files here are staged on the Windows laptop and copied to the Pi (`~/plotter/`)
once it is reachable. Guide: `docs/cr6se-plotter-build-guide.md`

## Hardware facts established

- Mainboard: **Creality v4.5.2**
- Klipper build target (from upstream `config/printer-creality-cr6se-2020.cfg`):
  - STM32F103
  - **28 KiB bootloader**
  - Communication: **serial on USART1 (PA10/PA9)**, reached over the board's USB
- Pi 4, hostname `plotter`, user `jkevin`

## Pin map, stock -> plotter

| Pin  | Stock use          | Plotter use |
|------|--------------------|-------------|
| PA4  | strain gauge probe | unused (Option C Z-homing if ever wanted) |
| PA6  | case LED output    | **servo signal candidate** |
| PA7  | filament switch in | **Z endstop candidate** (Option A) |
| PA0/PA1/PA2 | fans, hotend, bed | deleted from config |

Both PA6 and PA7 are freed by the strip, so Option A (mechanical Z switch)
and a mainboard-timed servo can coexist. Confirm physically at Phase 1.1/6.2.

## Status

- [x] Phase 1 - board identified, build target derived
- [~] Phase 2 - Pi imaged; **not yet on the network** (see below)
- [ ] Phase 3 - firmware build + flash
- [ ] Phase 4 - motion config

## Open problem: Pi will not join WiFi

The Pi boots correctly (rootfs auto-expanded 2.6 GB -> 59 GB, which only
happens on a successful boot) but ignored two headless-config formats:

1. `rpi-preseed.toml` - written per rpi-imager docs for Trixie. Ignored.
2. cloud-init `user-data` / `network-config` - files present on the image but
   apparently not processed. Ignored (no `runcmd` side effects appeared).

Current attempt: the `systemd.run=` + `firstrun.sh` mechanism taken from
rpi-imager's own source (`src/downloadthread.cpp`), which is independent of
whichever config package the image ships. It writes `/boot/firmware/firstrun.log`
and installs `plotter-diag.service` to dump full network state to
`/boot/firmware/diag/net.txt` on the following boot.

**Next diagnostic step:** read `firstrun.log` off the card. Its presence or
absence is decisive - absent means `systemd.run` never fired, present means the
script ran and the log says exactly how far it got.

Fallback if WiFi keeps failing: wired ethernet to the Pi. The configs already
accept DHCP on eth0.
