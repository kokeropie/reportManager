-- Creates the app database and a login for it. Run once, as a SQL Server admin, for example:
--
--   sqlcmd -S localhost -E -i deploy\create-database.sql ^
--          -v DbName="ReportServer" LoginName="report_app" LoginPassword="<strong password, no single quote>"
--
-- Or open it in SSMS, turn on SQLCMD Mode (Query menu), and set the three values below.
-- SQL Server must allow TCP/IP and SQL authentication (mixed mode). Safe to run again.
:setvar DbName "ReportServer"
:setvar LoginName "report_app"
:setvar LoginPassword "CHANGE-ME-to-a-strong-password"

IF DB_ID(N'$(DbName)') IS NULL CREATE DATABASE [$(DbName)];
GO
IF SUSER_ID(N'$(LoginName)') IS NULL
  CREATE LOGIN [$(LoginName)] WITH PASSWORD = N'$(LoginPassword)', CHECK_POLICY = ON;
GO
USE [$(DbName)];
GO
IF USER_ID(N'$(LoginName)') IS NULL CREATE USER [$(LoginName)] FOR LOGIN [$(LoginName)];
ALTER ROLE db_owner ADD MEMBER [$(LoginName)];
GO
PRINT 'Done. Put the login in .env as APP_DB_USER / APP_DB_PASSWORD.';
