# Instant Mock API

⚡ Paste JSON, get a live URL. No signup.

An instant mock API service for frontend developers who need a fake backend in ~10 seconds. Perfect for prototyping, testing, and learning.

## Features

- **Instant**: Paste JSON, get a working API URL immediately
- **No Signup**: No accounts, no authentication - just paste and go
- **REST Support**: Automatic REST routes for your data
- **CORS Enabled**: Works from any browser
- **24h TTL**: Mocks auto-expire after 24 hours
- **Limits**: ~100KB body size, ~1k records

## Quick Start

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run locally:**
   ```bash
   npm run dev
   ```
   
   Open http://localhost:8787 in your browser.

### Deploy to Cloudflare Workers

1. **Install Wrangler CLI (if not already installed):**
   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare:**
   ```bash
   wrangler login
   ```

3. **Create KV namespace:**
   ```bash
   npx wrangler kv namespace create MOCKS
   ```
   
   This will output something like:
   ```
   { binding = "MOCKS", id = "1234567890abcdef1234567890abcdef" }
   ```

4. **Update wrangler.toml:**
   
   Open `wrangler.toml` and replace the placeholder KV namespace configuration (the commented-out section) with the real id:
   
   ```toml
   # Uncomment and use this for production:
   [[kv_namespaces]]
   binding = "MOCKS"
   id = "1234567890abcdef1234567890abcdef"  # Use your actual id from step 3
   ```
   
   Then comment out or remove the local dev placeholder binding:
   ```toml
   # Comment out for production:
   # [[kv_namespaces]]
   # binding = "MOCKS"
   # id = "00000000000000000000000000000000"
   ```

5. **Deploy:**
   ```bash
   npm run deploy
   ```
   
   Your app will be live at `https://instant-mock.<your-subdomain>.workers.dev`

## How It Works

### Creating a Mock

1. Visit the landing page
2. Paste your JSON data (sample provided)
3. Click "Get URL"
4. Your mock API is live at `https://your-domain/m/:id`

### API Routes

The service automatically creates REST routes based on your JSON structure:

#### Collection Object (object of arrays)
```json
{
  "users": [
    { "id": 1, "name": "Alice" }
  ],
  "posts": [
    { "id": 1, "title": "Hello" }
  ]
}
```

Routes:
- `GET /users` - List all users
- `POST /users` - Create user (returns with ID)
- `GET /users/1` - Get user by ID
- `PATCH /users/1` - Update user
- `DELETE /users/1` - Delete user

Same pattern for `/posts`, `/products`, etc.

#### Array
```json
[
  { "id": 1, "product": "Laptop" },
  { "id": 2, "product": "Mouse" }
]
```

Routes:
- `GET /items` - List all items
- `POST /items` - Create item
- `GET /items/1` - Get item by ID
- `PATCH /items/1` - Update item
- `DELETE /items/1` - Delete item

#### Single Object
```json
{
  "name": "My App",
  "version": "1.0.0"
}
```

Routes:
- `GET /` - Get the object

## Examples

### Create a mock:
```bash
curl -X POST https://your-domain/api/create \
  -H "Content-Type: application/json" \
  -d '{"users":[{"id":1,"name":"Alice"}]}'
```

Response:
```json
{
  "id": "abc123def456",
  "url": "https://your-domain/m/abc123def456",
  "expiresAt": "2024-09-10T16:25:00Z"
}
```

### Use the mock:
```bash
# List users
curl https://your-domain/m/abc123def456/users

# Get specific user
curl https://your-domain/m/abc123def456/users/1

# Create user (persisted until TTL)
curl -X POST https://your-domain/m/abc123def456/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Bob","email":"bob@example.com"}'

# Update user (persisted until TTL)
curl -X PATCH https://your-domain/m/abc123def456/users/1 \
  -H "Content-Type: application/json" \
  -d '{"email":"alice.new@example.com"}'

# Delete user (persisted until TTL)
curl -X DELETE https://your-domain/m/abc123def456/users/1
```

## Limitations

- **TTL**: Mocks expire after 24 hours
- **Size**: Max 100KB per mock
- **Records**: Max ~1,000 records per mock
- **Storage**: URL is the only key - lose it, it's gone
- **No Auth**: Anyone with the URL can access the mock
- **ID Support**: Both string and number IDs are supported for lookups

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Storage**: Cloudflare KV (with TTL)
- **Language**: TypeScript
- **Framework**: None (vanilla JS)

## Out of Scope

This is an MVP focused on the 10-second path. Not included:
- Authentication/Authorization
- OpenAPI/Swagger generation
- GraphQL support
- Faker/generated data
- Teams/collaboration
- Custom domains
- Persistence beyond 24h TTL

## License

MIT
