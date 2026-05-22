#!/bin/bash
# Entrypoint script for jchat with Schoology support

# Initialize database if it doesn't exist
if [ ! -f "${DATA_DIR}/chat.db" ]; then
    echo "Initializing database..."
    node server/scripts/init-db.js
fi

# Start supervisord (runs both Node.js and Flask services)
exec supervisord -c /etc/supervisor/conf.d/schoology.conf