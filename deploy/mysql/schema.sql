-- MySQL 8 schema for the greenhouse controller (reference copy).
-- `greenhouse init-db` creates the same tables; this file is for review and the manuscript.

CREATE TABLE actuator_events (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	actuator_id VARCHAR(40) NOT NULL, 
	action VARCHAR(16) NOT NULL, 
	reason VARCHAR(255) NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	duration_s FLOAT, 
	issued_by VARCHAR(120) NOT NULL, 
	cmd_id VARCHAR(64), 
	detail JSON, 
	occurred_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_actuator_events_actuator_id ON actuator_events (actuator_id);
CREATE INDEX ix_actuator_events_occurred_at ON actuator_events (occurred_at);

CREATE TABLE actuators (
	id VARCHAR(40) NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	grp VARCHAR(24) NOT NULL, 
	installed BOOL NOT NULL, 
	state BOOL NOT NULL, 
	mode VARCHAR(8) NOT NULL, 
	last_changed DATETIME, 
	PRIMARY KEY (id)
);

CREATE TABLE alerts (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	severity VARCHAR(10) NOT NULL, 
	source VARCHAR(40) NOT NULL, 
	code VARCHAR(40) NOT NULL, 
	message VARCHAR(255) NOT NULL, 
	dedupe_key VARCHAR(100) NOT NULL, 
	raised_at DATETIME NOT NULL, 
	last_seen_at DATETIME NOT NULL, 
	resolved_at DATETIME, 
	acknowledged_by VARCHAR(120), 
	acknowledged_at DATETIME, 
	detail JSON, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_alerts_dedupe_key ON alerts (dedupe_key);
CREATE INDEX ix_alerts_raised_at ON alerts (raised_at);

CREATE TABLE audit_log (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	actor VARCHAR(120) NOT NULL, 
	action VARCHAR(48) NOT NULL, 
	target VARCHAR(80) NOT NULL, 
	detail JSON, 
	occurred_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_audit_log_occurred_at ON audit_log (occurred_at);

CREATE TABLE calibrations (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	sensor_id VARCHAR(40) NOT NULL, 
	constants JSON NOT NULL, 
	performed_by VARCHAR(120) NOT NULL, 
	performed_at DATETIME NOT NULL, 
	note VARCHAR(255) NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_calibrations_sensor_id ON calibrations (sensor_id);

CREATE TABLE commands (
	cmd_id VARCHAR(64) NOT NULL, 
	actuator_id VARCHAR(40) NOT NULL, 
	action VARCHAR(8) NOT NULL, 
	duration_s INTEGER, 
	target_g FLOAT, 
	circuit VARCHAR(16), 
	issued_by VARCHAR(120) NOT NULL, 
	reason VARCHAR(64) NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	status_reason VARCHAR(64), 
	message VARCHAR(255), 
	issued_at DATETIME NOT NULL, 
	received_at DATETIME NOT NULL, 
	resolved_at DATETIME, 
	PRIMARY KEY (cmd_id)
);

CREATE TABLE fertigation_doses (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	target_g FLOAT NOT NULL, 
	delivered_g FLOAT, 
	status VARCHAR(16) NOT NULL, 
	reason VARCHAR(64) NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	issued_by VARCHAR(120) NOT NULL, 
	cmd_id VARCHAR(64), 
	started_at DATETIME NOT NULL, 
	finished_at DATETIME, 
	PRIMARY KEY (id)
);

CREATE TABLE growth_stages (
	id VARCHAR(16) NOT NULL, 
	name VARCHAR(40) NOT NULL, 
	sequence INTEGER NOT NULL, 
	irrigation_mode VARCHAR(16) NOT NULL, 
	description VARCHAR(255) NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE kv (
	`key` VARCHAR(64) NOT NULL, 
	value TEXT NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (`key`)
);

CREATE TABLE sensor_readings (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	sensor_id VARCHAR(40) NOT NULL, 
	value FLOAT, 
	raw FLOAT, 
	unit VARCHAR(16) NOT NULL, 
	quality VARCHAR(16) NOT NULL, 
	recorded_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_readings_sensor_time ON sensor_readings (sensor_id, recorded_at);
CREATE INDEX ix_readings_time ON sensor_readings (recorded_at);

CREATE TABLE sensor_readings_15m (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	sensor_id VARCHAR(40) NOT NULL, 
	bucket_start DATETIME NOT NULL, 
	avg_value FLOAT NOT NULL, 
	min_value FLOAT NOT NULL, 
	max_value FLOAT NOT NULL, 
	samples INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_15m_sensor_bucket UNIQUE (sensor_id, bucket_start)
);

CREATE TABLE users (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	email VARCHAR(190) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	password_hash VARCHAR(255) NOT NULL, 
	`role` VARCHAR(16) NOT NULL, 
	active BOOL NOT NULL, 
	token_version INTEGER NOT NULL, 
	created_at DATETIME NOT NULL, 
	last_login_at DATETIME, 
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ix_users_email ON users (email);

CREATE TABLE zones (
	id INTEGER NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	description VARCHAR(255) NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE sensors (
	id VARCHAR(40) NOT NULL, 
	zone_id INTEGER NOT NULL, 
	type VARCHAR(32) NOT NULL, 
	host VARCHAR(16) NOT NULL, 
	unit VARCHAR(16) NOT NULL, 
	installed BOOL NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	calibrated_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(zone_id) REFERENCES zones (id)
);

CREATE TABLE thresholds (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	stage_id VARCHAR(16) NOT NULL, 
	parameter VARCHAR(32) NOT NULL, 
	min_value FLOAT NOT NULL, 
	max_value FLOAT NOT NULL, 
	deadband FLOAT NOT NULL, 
	version INTEGER NOT NULL, 
	updated_at DATETIME NOT NULL, 
	updated_by VARCHAR(120) NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_threshold_stage_param UNIQUE (stage_id, parameter), 
	FOREIGN KEY(stage_id) REFERENCES growth_stages (id)
);

