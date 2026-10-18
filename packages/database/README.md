# @wai-bridge/database

SQLite persistence engine for the local API process. The Chrome extension and macOS relay must not open this database. `openDatabase()` enables foreign keys, WAL, configurable busy timeout, and versioned migrations. Migration files are immutable after application; add a new numbered file for schema changes. Repository methods use parameterized SQL and Zod input validation.

The package stores media metadata only; binary media belongs in protected filesystem storage. Backups use SQLite's online backup API. Retention and encryption/key management remain governed by separate approved decisions.
# Migration 005 adds per-consumer AI message states with lease deadlines, claim tokens, and recovery indexes. Earlier migrations remain checksum guarded and unchanged.
