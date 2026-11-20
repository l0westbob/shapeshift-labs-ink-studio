#!/bin/bash
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../_fixtures/setup.sh" broken.json:scenes/broken.json
