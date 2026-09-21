#!/bin/bash
cd "$(dirname "$0")"
(sleep 1 && open "http://localhost:8421") &
exec ./.venv/bin/python server.py
