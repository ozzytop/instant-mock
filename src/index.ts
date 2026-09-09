interface Env {
  MOCKS: KVNamespace;
}

interface MockData {
  data: any;
  createdAt: number;
}

const MAX_SIZE_BYTES = 100 * 1024; // 100KB
const MAX_RECORDS = 1000;
const TTL_SECONDS = 24 * 60 * 60; // 24 hours
const TTL_MS = TTL_SECONDS * 1000;

function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function countRecords(data: any): number {
  if (Array.isArray(data)) return data.length;
  if (typeof data === 'object' && data !== null) {
    return Object.values(data).reduce((sum: number, val) => {
      return sum + (Array.isArray(val) ? val.length : 0);
    }, 0 as number);
  }
  return 0;
}

async function getMockData(env: Env, mockId: string): Promise<MockData | null> {
  const raw = await env.MOCKS.get(`mock:${mockId}`);
  if (!raw) return null;
  
  const mockData: MockData = JSON.parse(raw);
  const age = Date.now() - mockData.createdAt;
  
  if (age > TTL_MS) {
    await env.MOCKS.delete(`mock:${mockId}`);
    return null;
  }
  
  return mockData;
}

async function updateMockData(env: Env, mockId: string, newData: any): Promise<void> {
  const mockData = await getMockData(env, mockId);
  if (!mockData) return;
  
  const updatedMockData: MockData = {
    data: newData,
    createdAt: mockData.createdAt,
  };
  
  const remainingTtl = Math.max(0, Math.floor((TTL_MS - (Date.now() - mockData.createdAt)) / 1000));
  await env.MOCKS.put(`mock:${mockId}`, JSON.stringify(updatedMockData), {
    expirationTtl: remainingTtl,
  });
}

function matchId(itemId: any, pathId: string): boolean {
  return String(itemId) === pathId || Number(itemId) === Number(pathId);
}

async function handleCreateMock(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    
    const size = JSON.stringify(body).length;
    if (size > MAX_SIZE_BYTES) {
      return jsonResponse({ error: 'Payload too large (max 100KB)' }, 413);
    }
    
    const recordCount = countRecords(body);
    if (recordCount > MAX_RECORDS) {
      return jsonResponse({ error: `Too many records (max ${MAX_RECORDS})` }, 413);
    }
    
    const mockId = generateId();
    const mockData: MockData = {
      data: body,
      createdAt: Date.now(),
    };
    
    await env.MOCKS.put(`mock:${mockId}`, JSON.stringify(mockData), {
      expirationTtl: TTL_SECONDS,
    });
    
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    
    return jsonResponse({ 
      id: mockId,
      url: `${baseUrl}/m/${mockId}`,
      expiresAt: new Date(mockData.createdAt + TTL_MS).toISOString(),
    }, 201);
  } catch (error) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }
}

async function handleMockRequest(
  request: Request,
  env: Env,
  mockId: string,
  path: string
): Promise<Response> {
  const mockData = await getMockData(env, mockId);
  
  if (!mockData) {
    return jsonResponse({ error: 'Mock not found or expired' }, 410);
  }
  
  const data = mockData.data;
  const method = request.method;
  
  // Single object: GET /
  if (!Array.isArray(data) && typeof data === 'object' && !isCollectionObject(data)) {
    if (path === '' && method === 'GET') {
      return jsonResponse(data);
    }
    return jsonResponse({ error: 'Not found' }, 404);
  }
  
  // Raw array: /items
  if (Array.isArray(data)) {
    return handleArrayRoutes(env, mockId, data, path, method, request);
  }
  
  // Collection object (object of arrays)
  if (isCollectionObject(data)) {
    return handleCollectionRoutes(env, mockId, data, path, method, request);
  }
  
  return jsonResponse({ error: 'Unsupported data structure' }, 400);
}

function isCollectionObject(data: any): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }
  return Object.values(data).some(val => Array.isArray(val));
}

async function handleArrayRoutes(
  env: Env,
  mockId: string,
  data: any[],
  path: string,
  method: string,
  request: Request
): Promise<Response> {
  // GET /items
  if (path === 'items' && method === 'GET') {
    return jsonResponse(data);
  }
  
  // POST /items
  if (path === 'items' && method === 'POST') {
    try {
      const newItem = await request.json() as any;
      const newId = data.length > 0 ? Math.max(...data.map((i: any) => Number(i.id) || 0)) + 1 : 1;
      const itemWithId = { ...newItem, id: newId };
      const updatedData = [...data, itemWithId];
      await updateMockData(env, mockId, updatedData);
      return jsonResponse(itemWithId, 201);
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }
  }
  
  // GET /items/:id
  const itemMatch = path.match(/^items\/(.+)$/);
  if (itemMatch && method === 'GET') {
    const pathId = itemMatch[1];
    const item = data.find((i: any) => matchId(i.id, pathId));
    if (item) return jsonResponse(item);
    return jsonResponse({ error: 'Item not found' }, 404);
  }
  
  // PATCH /items/:id
  if (itemMatch && method === 'PATCH') {
    const pathId = itemMatch[1];
    const itemIndex = data.findIndex((i: any) => matchId(i.id, pathId));
    if (itemIndex === -1) return jsonResponse({ error: 'Item not found' }, 404);
    try {
      const updates = await request.json() as any;
      const updatedItem = { ...data[itemIndex], ...updates };
      const updatedData = [...data];
      updatedData[itemIndex] = updatedItem;
      await updateMockData(env, mockId, updatedData);
      return jsonResponse(updatedItem);
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }
  }
  
  // DELETE /items/:id
  if (itemMatch && method === 'DELETE') {
    const pathId = itemMatch[1];
    const itemIndex = data.findIndex((i: any) => matchId(i.id, pathId));
    if (itemIndex === -1) return jsonResponse({ error: 'Item not found' }, 404);
    const updatedData = data.filter((_, idx) => idx !== itemIndex);
    await updateMockData(env, mockId, updatedData);
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  
  return jsonResponse({ error: 'Not found' }, 404);
}

async function handleCollectionRoutes(
  env: Env,
  mockId: string,
  data: Record<string, any>,
  path: string,
  method: string,
  request: Request
): Promise<Response> {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    return jsonResponse({ error: 'Specify a collection' }, 400);
  }
  
  const collectionName = segments[0];
  const collection = data[collectionName];
  
  if (!Array.isArray(collection)) {
    return jsonResponse({ error: 'Collection not found' }, 404);
  }
  
  // GET /collection
  if (segments.length === 1 && method === 'GET') {
    return jsonResponse(collection);
  }
  
  // POST /collection
  if (segments.length === 1 && method === 'POST') {
    try {
      const newItem = await request.json() as any;
      const newId = collection.length > 0 ? Math.max(...collection.map((i: any) => Number(i.id) || 0)) + 1 : 1;
      const itemWithId = { ...newItem, id: newId };
      const updatedCollection = [...collection, itemWithId];
      const updatedData = { ...data, [collectionName]: updatedCollection };
      await updateMockData(env, mockId, updatedData);
      return jsonResponse(itemWithId, 201);
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }
  }
  
  // GET /collection/:id
  if (segments.length === 2 && method === 'GET') {
    const pathId = segments[1];
    const item = collection.find((i: any) => matchId(i.id, pathId));
    if (item) return jsonResponse(item);
    return jsonResponse({ error: 'Item not found' }, 404);
  }
  
  // PATCH /collection/:id
  if (segments.length === 2 && method === 'PATCH') {
    const pathId = segments[1];
    const itemIndex = collection.findIndex((i: any) => matchId(i.id, pathId));
    if (itemIndex === -1) return jsonResponse({ error: 'Item not found' }, 404);
    try {
      const updates = await request.json() as any;
      const updatedItem = { ...collection[itemIndex], ...updates };
      const updatedCollection = [...collection];
      updatedCollection[itemIndex] = updatedItem;
      const updatedData = { ...data, [collectionName]: updatedCollection };
      await updateMockData(env, mockId, updatedData);
      return jsonResponse(updatedItem);
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }
  }
  
  // DELETE /collection/:id
  if (segments.length === 2 && method === 'DELETE') {
    const pathId = segments[1];
    const itemIndex = collection.findIndex((i: any) => matchId(i.id, pathId));
    if (itemIndex === -1) return jsonResponse({ error: 'Item not found' }, 404);
    const updatedCollection = collection.filter((_, idx) => idx !== itemIndex);
    const updatedData = { ...data, [collectionName]: updatedCollection };
    await updateMockData(env, mockId, updatedData);
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  
  return jsonResponse({ error: 'Not found' }, 404);
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Instant Mock API</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 800px;
      width: 100%;
      padding: 40px;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 2rem;
    }
    .tagline {
      color: #666;
      margin-bottom: 30px;
      font-size: 1.1rem;
    }
    textarea {
      width: 100%;
      height: 300px;
      padding: 15px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-family: "Monaco", "Courier New", monospace;
      font-size: 14px;
      resize: vertical;
      margin-bottom: 20px;
    }
    textarea:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 15px 40px;
      border-radius: 8px;
      font-size: 1.1rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .result {
      margin-top: 20px;
      padding: 20px;
      background: #f5f5f5;
      border-radius: 8px;
      display: none;
    }
    .result.show { display: block; }
    .result.success { background: #d4edda; border-left: 4px solid #28a745; }
    .result.error { background: #f8d7da; border-left: 4px solid #dc3545; }
    .url-box {
      background: white;
      padding: 15px;
      border-radius: 6px;
      font-family: monospace;
      word-break: break-all;
      margin: 10px 0;
      border: 1px solid #ddd;
    }
    .copy-btn {
      background: #28a745;
      padding: 8px 20px;
      font-size: 0.9rem;
      margin-top: 10px;
    }
    .examples {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 2px solid #e0e0e0;
    }
    .examples h3 {
      color: #555;
      margin-bottom: 10px;
      font-size: 1rem;
    }
    .example-btn {
      background: #6c757d;
      padding: 8px 16px;
      font-size: 0.85rem;
      margin: 5px 5px 5px 0;
    }
    .info {
      background: #e7f3ff;
      border-left: 4px solid #2196F3;
      padding: 15px;
      margin-top: 20px;
      border-radius: 4px;
      font-size: 0.9rem;
      color: #555;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚡ Instant Mock API</h1>
    <p class="tagline">Paste JSON, get a live URL. No signup.</p>
    
    <textarea id="jsonInput" placeholder="Paste your JSON here...">{
  "users": [
    { "id": 1, "name": "Alice", "email": "alice@example.com" },
    { "id": 2, "name": "Bob", "email": "bob@example.com" }
  ],
  "posts": [
    { "id": 1, "userId": 1, "title": "Hello World", "body": "First post" },
    { "id": 2, "userId": 2, "title": "Mock APIs", "body": "So easy!" }
  ]
}</textarea>
    
    <button id="createBtn">Get URL</button>
    
    <div id="result" class="result"></div>
    
    <div class="info">
      <strong>How it works:</strong> Paste JSON → Click "Get URL" → Use your mock API with full REST support.
      <br><strong>Limits:</strong> 24h TTL, 100KB max, ~1k records, CORS enabled.
    </div>
    
    <div class="examples">
      <h3>Try these examples:</h3>
      <button class="example-btn" onclick="loadExample('collection')">Collection</button>
      <button class="example-btn" onclick="loadExample('array')">Array</button>
      <button class="example-btn" onclick="loadExample('single')">Single Object</button>
    </div>
  </div>

  <script>
    const examples = {
      collection: {
        "users": [
          { "id": 1, "name": "Alice", "email": "alice@example.com" },
          { "id": 2, "name": "Bob", "email": "bob@example.com" }
        ],
        "posts": [
          { "id": 1, "userId": 1, "title": "Hello World", "body": "First post" },
          { "id": 2, "userId": 2, "title": "Mock APIs", "body": "So easy!" }
        ]
      },
      array: [
        { "id": 1, "product": "Laptop", "price": 999 },
        { "id": 2, "product": "Mouse", "price": 29 },
        { "id": 3, "product": "Keyboard", "price": 79 }
      ],
      single: {
        "name": "My App",
        "version": "1.0.0",
        "status": "active",
        "features": ["fast", "simple", "free"]
      }
    };

    function loadExample(type) {
      document.getElementById('jsonInput').value = JSON.stringify(examples[type], null, 2);
    }

    document.getElementById('createBtn').addEventListener('click', async () => {
      const btn = document.getElementById('createBtn');
      const resultDiv = document.getElementById('result');
      const input = document.getElementById('jsonInput').value;
      
      resultDiv.classList.remove('show', 'success', 'error');
      btn.disabled = true;
      btn.textContent = 'Creating...';
      
      try {
        const json = JSON.parse(input);
        
        const response = await fetch('/api/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(json)
        });
        
        const data = await response.json();
        
        if (!response.ok) {
          throw new Error(data.error || 'Failed to create mock');
        }
        
        resultDiv.innerHTML = \`
          <strong>✅ Mock API created!</strong>
          <div class="url-box">\${data.url}</div>
          <button id="copyUrlBtn" class="copy-btn" onclick="copyUrl('\${data.url}', 'copyUrlBtn')">Copy URL</button>
          <p style="margin-top: 15px; color: #666; font-size: 0.9rem;">
            Expires: \${new Date(data.expiresAt).toLocaleString()}
          </p>
          <p style="margin-top: 10px; color: #666; font-size: 0.9rem;">
            <strong>Routes available:</strong><br>
            Collection: GET/POST /collection, GET/PATCH/DELETE /collection/:id<br>
            Array: GET/POST /items, GET/PATCH/DELETE /items/:id<br>
            Single: GET /
          </p>
        \`;
        resultDiv.classList.add('show', 'success');
        
        copyUrl(data.url, 'copyUrlBtn');
        
      } catch (error) {
        resultDiv.innerHTML = \`<strong>❌ Error:</strong> \${error.message}\`;
        resultDiv.classList.add('show', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Get URL';
      }
    });

    function copyUrl(url, buttonId) {
      const btn = buttonId ? document.getElementById(buttonId) : null;
      navigator.clipboard.writeText(url).then(() => {
        if (btn) {
          const originalText = btn.textContent;
          btn.textContent = '✓ Copied!';
          btn.style.background = '#28a745';
          setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
          }, 2000);
        }
      }).catch(err => {
        console.error('Failed to copy:', err);
        if (btn) {
          const originalText = btn.textContent;
          btn.textContent = '✗ Copy failed - select URL manually';
          btn.style.background = '#dc3545';
          setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
          }, 3000);
        } else {
          alert('Failed to copy URL to clipboard. Please select and copy manually.');
        }
      });
    }
  </script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle OPTIONS for CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    
    // Serve landing page
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(HTML_PAGE, {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    
    // Create mock API
    if (url.pathname === '/api/create' && request.method === 'POST') {
      return handleCreateMock(request, env);
    }
    
    // Handle mock requests: /m/:id/...
    const mockMatch = url.pathname.match(/^\/m\/([^\/]+)(\/(.*))?$/);
    if (mockMatch) {
      const mockId = mockMatch[1];
      const path = mockMatch[3] || '';
      return handleMockRequest(request, env, mockId, path);
    }
    
    return jsonResponse({ error: 'Not found' }, 404);
  },
};
