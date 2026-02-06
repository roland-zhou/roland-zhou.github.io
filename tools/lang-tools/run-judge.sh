#!/bin/bash

# Example runner script for prompts-judge.js
# Set your API keys here or source them from a .env file

echo "🧪 Starting Prompt Quality Judge..."
echo ""

# Check if .env exists and source it
if [ -f ".env" ]; then
    echo "📄 Loading API keys from .env file..."
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "⚠️  No .env file found. Using existing environment variables..."
fi

# Validate required API keys
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "❌ ANTHROPIC_API_KEY not set (required for judge model)"
    exit 1
fi

echo "✅ API keys loaded"
echo ""

# Run the judge
node prompts-judge.js

echo ""
echo "✅ Judge completed!"
