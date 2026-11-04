-- Creates the app database and a login for it on MariaDB. Run once as a MariaDB admin on the Ubuntu server:
--
--   sudo mysql < deploy/create-database.sql
--
-- Edit the three values below first (password: strong, no single quote). Safe to run again.
-- To let the app connect from another machine, change 'localhost' in the two GRANT/USER lines to that machine's address (or '%').
CREATE DATABASE IF NOT EXISTS reportserver CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'report_app'@'localhost' IDENTIFIED BY 'CHANGE-ME-to-a-strong-password';
GRANT ALL PRIVILEGES ON reportserver.* TO 'report_app'@'localhost';
FLUSH PRIVILEGES;
-- Then put the login in .env as APP_DB_USER=report_app / APP_DB_PASSWORD, APP_DB_NAME=reportserver.
