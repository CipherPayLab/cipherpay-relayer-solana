# Database Permissions Setup

## Flow: Where Permissions Are Needed

When you run `npm run migrate`, here's the flow:

```
npm run migrate
  ↓
scripts/migrate.ts
  ↓
getPool() from src/services/db/mysql.ts
  ↓
loadEnv() from src/services/config/env.ts
  ↓
Reads environment variables:
  - MYSQL_HOST (default: "127.0.0.1")
  - MYSQL_PORT (default: 3306)
  - MYSQL_USER (default: "cipherpay")
  - MYSQL_PASSWORD (default: "cipherpay")
  - MYSQL_DB (default: "cipherpay_relayer_solana")
  ↓
Creates MySQL connection pool with these credentials
  ↓
Executes SQL from src/db/migrations/*.sql
```

## Where to Grant Permissions

Permissions must be granted **in MySQL itself**, not in the code. The user specified by `MYSQL_USER` needs privileges on the database specified by `MYSQL_DB`.

### Option 1: Docker Init Script (Recommended for New Containers)

**Location**: `docker-entrypoint-initdb.d/01-init-permissions.sql`

This script runs automatically when the MySQL container is **first created** (only if the data directory is empty).

**Create the file**:
```bash
mkdir -p docker-entrypoint-initdb.d
```

**File content** (`docker-entrypoint-initdb.d/01-init-permissions.sql`):
```sql
-- Grant all privileges on the database to the cipherpay user
GRANT ALL PRIVILEGES ON cipherpay_relayer_solana.* TO 'cipherpay'@'%';
GRANT ALL PRIVILEGES ON cipherpay_relayer_solana.* TO 'cipherpay'@'localhost';
FLUSH PRIVILEGES;
```

**Note**: This only works on **first container creation**. If the database already exists, use Option 2 or 3.

### Option 2: Manual SQL Command (For Existing Containers)

Connect to MySQL as root and grant permissions:

```bash
docker exec -i cipherpay-relayer-solana mysql -uroot -proot <<'EOF'
GRANT ALL PRIVILEGES ON cipherpay_relayer_solana.* TO 'cipherpay'@'%';
GRANT ALL PRIVILEGES ON cipherpay_relayer_solana.* TO 'cipherpay'@'localhost';
FLUSH PRIVILEGES;
EOF
```

### Option 3: Helper Script

**Location**: `scripts/fix-permissions.sh`

```bash
#!/bin/bash
docker exec -i cipherpay-relayer-solana mysql -uroot -proot <<'EOF'
GRANT ALL PRIVILEGES ON cipherpay_relayer_solana.* TO 'cipherpay'@'%';
GRANT ALL PRIVILEGES ON cipherpay_relayer_solana.* TO 'cipherpay'@'localhost';
FLUSH PRIVILEGES;
EOF
echo "✅ Permissions granted"
```

Run it: `./scripts/fix-permissions.sh`

### Option 4: Docker Compose Command (One-time)

```bash
docker-compose exec db mysql -uroot -proot -e "GRANT ALL PRIVILEGES ON cipherpay_relayer_solana.* TO 'cipherpay'@'%'; FLUSH PRIVILEGES;"
```

## Verify Permissions

Check if permissions are granted:

```bash
docker exec -i cipherpay-relayer-solana mysql -uroot -proot -e "SHOW GRANTS FOR 'cipherpay'@'%';"
```

You should see:
```
GRANT ALL PRIVILEGES ON `cipherpay_relayer_solana`.* TO `cipherpay`@`%`
```

## Why Permissions Are Needed

The migration script needs to:
- `CREATE TABLE` - requires CREATE privilege
- `ALTER TABLE` - requires ALTER privilege  
- `CREATE INDEX` - requires INDEX privilege
- `INSERT`, `UPDATE`, `DELETE` - requires respective privileges

`ALL PRIVILEGES` grants all of these.

## Current Configuration

Based on `src/services/config/env.ts`:
- **User**: `cipherpay` (from `MYSQL_USER` env var, default: "cipherpay")
- **Database**: `cipherpay_relayer_solana` (from `MYSQL_DB` env var, default: "cipherpay_relayer_solana")
- **Host**: `127.0.0.1` (from `MYSQL_HOST` env var, default: "127.0.0.1")
- **Port**: `3306` (from `MYSQL_PORT` env var, default: 3306)

Make sure the user has permissions on the correct database!

