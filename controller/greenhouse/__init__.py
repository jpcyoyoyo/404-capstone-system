"""Smart Greenhouse controller — runs on the Raspberry Pi 5.

Services (each its own systemd unit in production):
  sensors  — ingest node readings, poll Pi-attached sensors, flag quality, store, publish
  control  — 30 s control loop, manual commands, interlocks, arbitration, actuators
  api      — REST API for the app and kiosk; serves the kiosk page
  sync     — replicates the local database to the cloud replica
"""
__version__ = "0.1.0"
