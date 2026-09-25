"""Runtime settings, all from environment variables (see deploy/greenhouse.env.example)."""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name, default)


@dataclass
class Settings:
    role: str = field(default_factory=lambda: _env("GH_ROLE", "controller"))  # controller | cloud
    registry_path: Path = field(default_factory=lambda: Path(_env("GH_REGISTRY", str(REPO_ROOT / "contract" / "registry.yaml"))))
    database_url: str = field(default_factory=lambda: _env("GH_DATABASE_URL", "sqlite:///./greenhouse.db"))
    mqtt_host: str = field(default_factory=lambda: _env("GH_MQTT_HOST", "localhost"))
    mqtt_port: int = field(default_factory=lambda: int(_env("GH_MQTT_PORT", "1883")))
    mqtt_username: str | None = field(default_factory=lambda: _env("GH_MQTT_USERNAME"))
    mqtt_password: str | None = field(default_factory=lambda: _env("GH_MQTT_PASSWORD"))
    # What the app is told to connect to for live data (WebSocket listener).
    mqtt_ws_url: str | None = field(default_factory=lambda: _env("GH_MQTT_WS_URL"))
    mqtt_app_username: str | None = field(default_factory=lambda: _env("GH_MQTT_APP_USERNAME"))
    mqtt_app_password: str | None = field(default_factory=lambda: _env("GH_MQTT_APP_PASSWORD"))
    jwt_secret: str = field(default_factory=lambda: _env("GH_JWT_SECRET") or secrets.token_hex(32))
    access_token_minutes: int = field(default_factory=lambda: int(_env("GH_ACCESS_TOKEN_MINUTES", "30")))
    refresh_token_days: int = field(default_factory=lambda: int(_env("GH_REFRESH_TOKEN_DAYS", "14")))
    kiosk_token: str | None = field(default_factory=lambda: _env("GH_KIOSK_TOKEN"))
    hal: str = field(default_factory=lambda: _env("GH_HAL", "sim"))  # sim | pi
    ack_timeout_s: float = field(default_factory=lambda: float(_env("GH_ACK_TIMEOUT_S", "8")))
    cycle_s_override: float | None = field(default_factory=lambda: float(v) if (v := _env("GH_CYCLE_S")) else None)
    web_root: Path | None = field(default_factory=lambda: Path(v) if (v := _env("GH_WEB_ROOT")) else None)
    cors_origins: str = field(default_factory=lambda: _env("GH_CORS_ORIGINS", "*"))
    network_mode: str = field(default_factory=lambda: _env("GH_NETWORK_MODE", "unknown"))
    # Sync (controller → cloud)
    cloud_url: str | None = field(default_factory=lambda: _env("GH_CLOUD_URL"))
    sync_token: str | None = field(default_factory=lambda: _env("GH_SYNC_TOKEN"))
    sync_interval_s: float = field(default_factory=lambda: float(_env("GH_SYNC_INTERVAL_S", "60")))
    # Dev-only fault-injection endpoints (/sim/*). Never enable on the real Pi.
    enable_sim_api: bool = field(default_factory=lambda: _env("GH_ENABLE_SIM_API", "0") == "1")


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def set_settings(s: Settings) -> None:
    global _settings
    _settings = s
