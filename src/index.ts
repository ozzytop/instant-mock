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
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}/m/${mockId}`;
  
  // Discovery endpoint: GET /m/:id (bare root)
  if (path === '' && method === 'GET') {
    // Single object: return the object directly
    if (!Array.isArray(data) && typeof data === 'object' && !isCollectionObject(data)) {
      return jsonResponse(data);
    }
    
    // Array shape: return discovery info
    if (Array.isArray(data)) {
      const itemCount = data.length;
      const sampleItem = itemCount > 0 ? data[0] : null;
      return jsonResponse({
        id: mockId,
        expiresAt: new Date(mockData.createdAt + TTL_MS).toISOString(),
        shape: 'array',
        itemCount,
        routes: {
          listItems: `GET ${baseUrl}/items`,
          createItem: `POST ${baseUrl}/items`,
          getItem: `GET ${baseUrl}/items/:id`,
          updateItem: `PATCH ${baseUrl}/items/:id`,
          deleteItem: `DELETE ${baseUrl}/items/:id`,
        },
        ...(sampleItem && { sampleItem }),
      });
    }
    
    // Collection object: return discovery info
    if (isCollectionObject(data)) {
      const collections = Object.keys(data).filter(key => Array.isArray(data[key]));
      const collectionInfo: Record<string, any> = {};
      collections.forEach(name => {
        const items = data[name];
        collectionInfo[name] = {
          itemCount: items.length,
          routes: {
            list: `GET ${baseUrl}/${name}`,
            create: `POST ${baseUrl}/${name}`,
            get: `GET ${baseUrl}/${name}/:id`,
            update: `PATCH ${baseUrl}/${name}/:id`,
            delete: `DELETE ${baseUrl}/${name}/:id`,
          },
        };
      });
      
      return jsonResponse({
        id: mockId,
        expiresAt: new Date(mockData.createdAt + TTL_MS).toISOString(),
        shape: 'collection',
        collections: collectionInfo,
      });
    }
  }
  
  // Single object: only GET / is valid
  if (!Array.isArray(data) && typeof data === 'object' && !isCollectionObject(data)) {
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
      let itemWithId = newItem;
      if (!newItem.id) {
        const newId = data.length > 0 ? Math.max(...data.map((i: any) => Number(i.id) || 0)) + 1 : 1;
        itemWithId = { ...newItem, id: newId };
      }
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
      let itemWithId = newItem;
      if (!newItem.id) {
        const newId = collection.length > 0 ? Math.max(...collection.map((i: any) => Number(i.id) || 0)) + 1 : 1;
        itemWithId = { ...newItem, id: newId };
      }
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
    .endpoints {
      margin-top: 15px;
    }
    .endpoint-group {
      margin-bottom: 20px;
    }
    .endpoint-group h4 {
      color: #444;
      font-size: 0.95rem;
      margin-bottom: 8px;
      font-weight: 600;
    }
    .endpoint-line {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 6px 0;
      padding: 8px 12px;
      background: white;
      border-radius: 4px;
      border: 1px solid #ddd;
      font-family: monospace;
      font-size: 0.85rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .endpoint-line:hover {
      background: #f8f9fa;
    }
    .endpoint-method {
      font-weight: bold;
      min-width: 55px;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.75rem;
    }
    .method-GET { color: #28a745; background: #d4edda; }
    .method-POST { color: #007bff; background: #cfe2ff; }
    .method-PATCH { color: #ffc107; background: #fff3cd; }
    .method-DELETE { color: #dc3545; background: #f8d7da; }
    .endpoint-url {
      flex: 1;
      color: #495057;
      word-break: break-all;
    }
    .endpoint-copy-icon {
      font-size: 1rem;
      opacity: 0.5;
      transition: opacity 0.2s;
    }
    .endpoint-line:hover .endpoint-copy-icon {
      opacity: 1;
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

    function isCollectionObject(data) {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return false;
      }
      return Object.values(data).some(val => Array.isArray(val));
    }

    function getExampleId(items) {
      if (!items || items.length === 0) return '1';
      const firstItem = items[0];
      return firstItem.id !== undefined ? firstItem.id : '1';
    }

    function generateEndpointsHTML(json, baseUrl) {
      let html = '<div class="endpoints">';
      
      // Single object
      if (!Array.isArray(json) && typeof json === 'object' && !isCollectionObject(json)) {
        html += '<div class="endpoint-group">';
        html += '<h4>Single Object</h4>';
        html += createEndpointLine('GET', baseUrl);
        html += '</div>';
        return html + '</div>';
      }
      
      // Array shape
      if (Array.isArray(json)) {
        const exampleId = getExampleId(json);
        html += '<div class="endpoint-group">';
        html += '<h4>Items Collection</h4>';
        html += createEndpointLine('GET', \`\${baseUrl}/items\`, 'List all items');
        html += createEndpointLine('POST', \`\${baseUrl}/items\`, 'Create new item');
        html += createEndpointLine('GET', \`\${baseUrl}/items/\${exampleId}\`, 'Get item by ID');
        html += createEndpointLine('PATCH', \`\${baseUrl}/items/\${exampleId}\`, 'Update item');
        html += createEndpointLine('DELETE', \`\${baseUrl}/items/\${exampleId}\`, 'Delete item');
        html += '</div>';
        return html + '</div>';
      }
      
      // Collection object
      if (isCollectionObject(json)) {
        const collections = Object.keys(json).filter(key => Array.isArray(json[key]));
        collections.forEach(name => {
          const items = json[name];
          const exampleId = getExampleId(items);
          html += '<div class="endpoint-group">';
          html += \`<h4>\${name.charAt(0).toUpperCase() + name.slice(1)}</h4>\`;
          html += createEndpointLine('GET', \`\${baseUrl}/\${name}\`, 'List all');
          html += createEndpointLine('POST', \`\${baseUrl}/\${name}\`, 'Create new');
          html += createEndpointLine('GET', \`\${baseUrl}/\${name}/\${exampleId}\`, 'Get by ID');
          html += createEndpointLine('PATCH', \`\${baseUrl}/\${name}/\${exampleId}\`, 'Update');
          html += createEndpointLine('DELETE', \`\${baseUrl}/\${name}/\${exampleId}\`, 'Delete');
          html += '</div>';
        });
        return html + '</div>';
      }
      
      return html + '</div>';
    }

    function createEndpointLine(method, url, description) {
      const id = 'endpoint_' + Math.random().toString(36).substr(2, 9);
      return \`
        <div class="endpoint-line" onclick="copyEndpoint('\${url}', '\${id}')">
          <span class="endpoint-method method-\${method}">\${method}</span>
          <span class="endpoint-url">\${url}</span>
          <span class="endpoint-copy-icon" id="\${id}">📋</span>
        </div>
      \`;
    }

    function copyEndpoint(url, iconId) {
      const icon = document.getElementById(iconId);
      navigator.clipboard.writeText(url).then(() => {
        icon.textContent = '✓';
        setTimeout(() => {
          icon.textContent = '📋';
        }, 2000);
      }).catch(err => {
        console.error('Failed to copy:', err);
        icon.textContent = '✗';
        setTimeout(() => {
          icon.textContent = '📋';
        }, 2000);
      });
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
        
        const endpointsHTML = generateEndpointsHTML(json, data.url);
        
        resultDiv.innerHTML = \`
          <strong>✅ Mock API created!</strong>
          <div class="url-box">\${data.url}</div>
          <button id="copyUrlBtn" class="copy-btn" onclick="copyUrl('\${data.url}', 'copyUrlBtn')">Copy URL</button>
          <p style="margin-top: 15px; color: #666; font-size: 0.9rem;">
            Expires: \${new Date(data.expiresAt).toLocaleString()}
          </p>
          <div style="margin-top: 15px;">
            <strong style="color: #444; font-size: 0.95rem;">📡 Available Endpoints:</strong>
            \${endpointsHTML}
          </div>
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
