#!/bin/bash
# Fix database permissions for existing databases
# Usage: ./scripts/fix-permissions.sh

docker exec -i cipherpay-relayer-solana mysql -uroot -proot <<EOF
GRANT ALL PRIVILEGES ON cipherpay_relayer_solana.* TO 'cipherpay'@'%';
GRANT ALL PRIVILEGES ON cipherpay_relayer_solana.* TO 'cipherpay'@'localhost';
FLUSH PRIVILEGES;
EOF

echo "✅ Permissions granted to cipherpay user"

