import { Cache, TTL } from "@mcp-stack/core";

export interface CDTokens {
  access_token: string;
  refresh_token: string;
  expires_at?: number; // epoch ms
}

export interface CDConfig {
  baseUrl: string;
  authUrl: string;
  clientId: string;
  clientSecret: string;
}

export class CenterDeviceClient {
  private tokens: CDTokens;
  private config: CDConfig;
  private cache = new Cache();

  constructor(config: CDConfig, tokens: CDTokens) {
    this.config = config;
    this.tokens = { ...tokens };
  }

  private get encodedCredentials(): string {
    return Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`
    ).toString("base64");
  }

  /**
   * Refresh the access token using the refresh token.
   */
  async refreshAccessToken(force = false): Promise<void> {
    if (!this.tokens.refresh_token) {
      throw new Error("No refresh token available. Run the auth flow first.");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refresh_token,
      ...(force ? { force: "true" } : {}),
    });

    const res = await fetch(`${this.config.authUrl}/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.encodedCredentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    };

    this.tokens.access_token = data.access_token;
    this.tokens.refresh_token = data.refresh_token;
    this.tokens.expires_at = Date.now() + data.expires_in * 1000;
    console.error("[cd-client] Token refreshed successfully");
  }

  /**
   * Check if access token is expired or about to expire (within 5 min).
   */
  private isTokenExpired(): boolean {
    if (!this.tokens.expires_at) return false; // unknown, try anyway
    return Date.now() > this.tokens.expires_at - 5 * 60 * 1000;
  }

  /**
   * Make an authenticated request to the CenterDevice API.
   */
  async request(
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Uint8Array | Buffer | FormData;
      accept?: string;
      rawResponse?: boolean;
    } = {}
  ): Promise<Response> {
    // Auto-refresh if expired
    if (this.isTokenExpired()) {
      await this.refreshAccessToken();
    }

    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.tokens.access_token}`,
      ...options.headers,
    };

    if (options.accept) {
      headers["Accept"] = options.accept;
    } else if (!headers["Accept"]) {
      headers["Accept"] = "application/json";
    }

    const res = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body as BodyInit | undefined,
    });

    // If 401, try refresh once and retry
    if (res.status === 401) {
      console.error("[cd-client] Got 401, attempting token refresh...");
      await this.refreshAccessToken(true);

      const retryHeaders = {
        ...headers,
        Authorization: `Bearer ${this.tokens.access_token}`,
      };

      return fetch(url, {
        method: options.method || "GET",
        headers: retryHeaders,
        body: options.body as BodyInit | undefined,
      });
    }

    return res;
  }

  /**
   * JSON request helper
   */
  async jsonRequest<T = unknown>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const res = await this.request(path, {
      method: options.method || "GET",
      headers: {
        ...(options.body
          ? { "Content-Type": "application/json; charset=UTF-8" }
          : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CenterDevice API error (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  // ─── Convenience methods ───────────────────────────────────────────

  /**
   * Search documents with fulltext and/or filters.
   */
  async searchDocuments(params: {
    query?: string;
    collection?: string;
    tags?: string[];
    owners?: string[];
    extensions?: string[];
    offset?: number;
    rows?: number;
  }): Promise<unknown> {
    const searchParams: Record<string, unknown> = {};

    if (params.query) {
      searchParams.query = { text: params.query };
    }

    const filter: Record<string, unknown> = {};
    if (params.collection)
      filter.collections = [params.collection];
    if (params.tags) filter.tags = params.tags;
    if (params.owners) filter.owners = params.owners;
    if (params.extensions) filter.extensions = params.extensions;
    if (Object.keys(filter).length > 0) searchParams.filter = filter;

    if (params.offset !== undefined) searchParams.offset = params.offset;
    searchParams.rows = params.rows || 20;

    return this.jsonRequest("/documents", {
      method: "POST",
      body: {
        action: "search",
        params: searchParams,
      },
    });
  }

  /**
   * Get metadata of a single document.
   */
  async getDocumentMetadata(
    documentId: string,
    includes?: string[]
  ): Promise<unknown> {
    const cacheKey = `doc:${documentId}:${(includes || []).join(",")}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let path = `/document/${documentId}`;
    if (includes && includes.length > 0) {
      path += `?includes=${includes.join(",")}`;
    }
    const result = await this.jsonRequest(path);
    this.cache.set(cacheKey, result, TTL.MIN_2);
    return result;
  }

  /**
   * Get metadata of multiple documents (by IDs or collection).
   */
  async getDocuments(params: {
    ids?: string[];
    collection?: string;
    folder?: string;
    offset?: number;
    rows?: number;
  }): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.ids) query.set("ids", params.ids.join(","));
    if (params.collection) query.set("collection", params.collection);
    if (params.folder) query.set("folder", params.folder);
    if (params.offset !== undefined)
      query.set("offset", String(params.offset));
    if (params.rows !== undefined) query.set("rows", String(params.rows));

    return this.jsonRequest(`/documents?${query.toString()}`);
  }

  /**
   * Download the fulltext representation of a document.
   */
  async getDocumentFulltext(
    documentId: string,
    version?: number
  ): Promise<string> {
    let path = `/document/${documentId}`;
    if (version) path += `;version=${version}`;
    path += "?wait-for-generation=10";

    const res = await this.request(path, { accept: "text/plain" });

    if (res.status === 307) {
      // Follow redirect for generation
      const location = res.headers.get("Location");
      if (location) {
        const retryRes = await this.request(
          location.replace(this.config.baseUrl, ""),
          { accept: "text/plain" }
        );
        if (retryRes.ok) return retryRes.text();
        return `[Fulltext not yet available, status ${retryRes.status}]`;
      }
    }

    if (res.status === 204) {
      return "[Fulltext generation timed out - try again later]";
    }

    if (!res.ok) {
      throw new Error(`Failed to get fulltext (${res.status})`);
    }

    return res.text();
  }

  /**
   * Download a document (binary). Returns buffer + content type.
   */
  async downloadDocument(
    documentId: string,
    version?: number
  ): Promise<{ data: Buffer; contentType: string; filename?: string }> {
    let path = `/document/${documentId}`;
    if (version) path += `;version=${version}`;

    const res = await this.request(path, {
      accept: "*/*",
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw new Error(`Download failed (${res.status}): ${errorBody}`);
    }

    const contentType = res.headers.get("Content-Type") || "application/octet-stream";
    const disposition = res.headers.get("Content-Disposition") || "";
    const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
    const data = Buffer.from(await res.arrayBuffer());

    return {
      data,
      contentType,
      filename: filenameMatch?.[1],
    };
  }

  /**
   * Upload a new document.
   */
  async uploadDocument(params: {
    filename: string;
    data: Buffer;
    contentType: string;
    title?: string;
    author?: string;
    tags?: string[];
    collections?: string[];
    folders?: string[];
  }): Promise<unknown> {
    // Build metadata per CenterDevice API spec section 5.2.1
    const document: Record<string, unknown> = {
      filename: params.filename,
    };
    if (params.title) document.title = params.title;
    if (params.author) document.author = params.author;

    const actions: Record<string, unknown> = {};
    if (params.collections && params.collections.length > 0)
      actions["add-to-collection"] = params.collections;
    if (params.folders && params.folders.length > 0)
      actions["add-to-folder"] = params.folders;
    if (params.tags && params.tags.length > 0)
      actions["add-tag"] = params.tags;

    const metadata: Record<string, unknown> = { document };
    if (Object.keys(actions).length > 0) metadata.actions = actions;

    const boundary = `----MCPBoundary${Date.now()}`;
    const CRLF = "\r\n";

    // Metadata part
    let body = "";
    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="metadata"${CRLF}`;
    body += `Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}`;
    body += JSON.stringify({ metadata }) + CRLF;

    // File part
    const fileHeader =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="document"; filename="${params.filename}"${CRLF}` +
      `Content-Type: ${params.contentType}${CRLF}${CRLF}`;

    const fileFooter = `${CRLF}--${boundary}--${CRLF}`;

    const headerBuf = Buffer.from(body + fileHeader, "utf-8");
    const footerBuf = Buffer.from(fileFooter, "utf-8");
    const fullBody = Buffer.concat([headerBuf, params.data, footerBuf]);

    const res = await this.request("/documents", {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: fullBody,
      accept: "application/json",
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }

    const location = res.headers.get("Location");
    const responseBody = await res.json() as object;
    return { location, ...responseBody };
  }

  /**
   * Upload a new version of an existing document.
   * POST /document/<document-id> with multipart body (same format as new upload but no actions).
   */
  async uploadNewVersion(params: {
    documentId: string;
    filename: string;
    data: Buffer;
    contentType: string;
  }): Promise<unknown> {
    const document: Record<string, unknown> = {
      filename: params.filename,
    };
    const metadata = { document };

    const boundary = `----MCPBoundary${Date.now()}`;
    const CRLF = "\r\n";

    let body = "";
    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="metadata"${CRLF}`;
    body += `Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}`;
    body += JSON.stringify({ metadata }) + CRLF;

    const fileHeader =
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="document"; filename="${params.filename}"${CRLF}` +
      `Content-Type: ${params.contentType}${CRLF}${CRLF}`;

    const fileFooter = `${CRLF}--${boundary}--${CRLF}`;

    const headerBuf = Buffer.from(body + fileHeader, "utf-8");
    const footerBuf = Buffer.from(fileFooter, "utf-8");
    const fullBody = Buffer.concat([headerBuf, params.data, footerBuf]);

    const res = await this.request(`/document/${params.documentId}`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: fullBody,
      accept: "application/json",
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload new version failed (${res.status}): ${text}`);
    }

    const location = res.headers.get("Location");
    const responseBody = await res.json();
    return { location, ...responseBody as object };
  }

  // ─── Collections ───────────────────────────────────────────────────

  async getCollection(collectionId: string): Promise<unknown> {
    const cacheKey = `coll:${collectionId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const result = await this.jsonRequest(`/collection/${collectionId}`);
    this.cache.set(cacheKey, result, TTL.MIN_5);
    return result;
  }

  async getCollections(ids?: string[]): Promise<unknown> {
    const cacheKey = `colls:${(ids || []).join(",")}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const query = ids ? `?ids=${ids.join(",")}` : "";
    const result = await this.jsonRequest(`/collections${query}`);
    this.cache.set(cacheKey, result, TTL.MIN_10);
    return result;
  }

  // ─── Tags ──────────────────────────────────────────────────────────

  async addTags(
    documentId: string,
    tags: string[]
  ): Promise<unknown> {
    this.cache.invalidate(`doc:${documentId}`);
    return this.jsonRequest(`/document/${documentId}`, {
      method: "POST",
      body: { action: "add-tag", params: { tags } },
    });
  }

  async removeTags(
    documentId: string,
    tags: string[]
  ): Promise<unknown> {
    this.cache.invalidate(`doc:${documentId}`);
    return this.jsonRequest(`/document/${documentId}`, {
      method: "POST",
      body: { action: "remove-tag", params: { tags } },
    });
  }

  // ─── Sharing ───────────────────────────────────────────────────────

  async shareDocument(
    documentId: string,
    users?: string[],
    groups?: string[]
  ): Promise<unknown> {
    this.cache.invalidate(`doc:${documentId}`);
    const params: Record<string, unknown> = {};
    if (users) params.users = users;
    if (groups) params.groups = groups;

    return this.jsonRequest(`/document/${documentId}`, {
      method: "POST",
      body: { action: "share", params },
    });
  }

  // ─── User info ─────────────────────────────────────────────────────

  async getCurrentUser(): Promise<unknown> {
    const cached = this.cache.get("current_user");
    if (cached) return cached;
    const result = await this.jsonRequest("/user/current");
    this.cache.set("current_user", result, TTL.HOUR_1);
    return result;
  }

  async getUsers(): Promise<unknown> {
    const cached = this.cache.get("users");
    if (cached) return cached;
    const result = await this.jsonRequest("/users");
    this.cache.set("users", result, TTL.MIN_30);
    return result;
  }

  // ─── Folders ───────────────────────────────────────────────────────

  async getFolder(folderId: string): Promise<unknown> {
    const cacheKey = `folder:${folderId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const result = await this.jsonRequest(`/folder/${folderId}`);
    this.cache.set(cacheKey, result, TTL.MIN_5);
    return result;
  }

  async getFolders(params: {
    collection?: string;
    parent?: string;
    document?: string;
    ids?: string[];
    path?: string;
    text?: string;
    group?: string;
    fields?: string[];
  }): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.collection) query.set("collection", params.collection);
    if (params.parent) query.set("parent", params.parent);
    if (params.document) query.set("document", params.document);
    if (params.ids && params.ids.length > 0) query.set("ids", params.ids.join(","));
    if (params.path) query.set("path", params.path);
    if (params.text) query.set("text", params.text);
    if (params.group) query.set("group", params.group);
    if (params.fields && params.fields.length > 0) query.set("fields", params.fields.join(","));

    const qs = query.toString();
    const cacheKey = `folders:${qs}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const result = await this.jsonRequest(`/folders?${qs}`);
    this.cache.set(cacheKey, result, TTL.MIN_5);
    return result;
  }

  // ─── Create Folder ─────────────────────────────────────────────────

  async createFolder(params: {
    name: string;
    collection?: string;
    parent?: string;
  }): Promise<unknown> {
    this.cache.invalidate("folders:");
    this.cache.invalidate("folder:");
    const result = await this.jsonRequest("/folders", {
      method: "POST",
      body: params,
    });
    return result;
  }

  // ─── Rename Folder ─────────────────────────────────────────────────

  async renameFolder(folderId: string, name: string): Promise<unknown> {
    this.cache.invalidate("folder:");
    this.cache.invalidate("folders:");
    const res = await this.request(`/folder/${folderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true, message: "Folder renamed" };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Rename folder failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Move Folder ──────────────────────────────────────────────────

  async moveFolder(folderId: string, params: {
    parent: string;
    collection?: string;
  }): Promise<unknown> {
    this.cache.invalidate("folder:");
    this.cache.invalidate("folders:");
    const body: Record<string, string> = { parent: params.parent };
    if (params.collection) body.collection = params.collection;

    const res = await this.request(`/folder/${folderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true, message: "Folder moved" };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Move folder failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Move Documents ────────────────────────────────────────────────

  async moveDocuments(params: {
    documents: string[];
    sourceCollection?: string;
    sourceFolder?: string;
    destinationCollection?: string;
    destinationFolder?: string;
  }): Promise<unknown> {
    // Invalidate cached metadata for moved documents
    for (const docId of params.documents) this.cache.invalidate(`doc:${docId}`);
    this.cache.invalidate("folders:");

    const body: Record<string, unknown> = {
      documents: params.documents,
    };
    if (params.sourceCollection) body["source-collection"] = params.sourceCollection;
    if (params.sourceFolder) body["source-folder"] = params.sourceFolder;
    if (params.destinationCollection) body["destination-collection"] = params.destinationCollection;
    if (params.destinationFolder) body["destination-folder"] = params.destinationFolder;

    const res = await this.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "move", params: body }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Move failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Add Documents to Folder ───────────────────────────────────────

  async addDocumentsToFolder(
    folderId: string,
    documents: string[]
  ): Promise<unknown> {
    for (const docId of documents) this.cache.invalidate(`doc:${docId}`);
    this.cache.invalidate(`folder:${folderId}`);

    const res = await this.request(`/folder/${folderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "add-documents", params: { documents } }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Add to folder failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Delete Document (move to trash) ───────────────────────────────

  async deleteDocument(documentId: string): Promise<unknown> {
    this.cache.invalidate(`doc:${documentId}`);
    const res = await this.request(`/document/${documentId}`, {
      method: "DELETE",
    });
    if (res.status === 204) return { success: true, message: "Document moved to trash" };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Delete failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Rename Document ───────────────────────────────────────────────

  async renameDocument(documentId: string, filename: string): Promise<unknown> {
    this.cache.invalidate(`doc:${documentId}`);
    const res = await this.request(`/document/${documentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "rename", params: { filename } }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true, message: "Filename unchanged (already matches)" };
    if (res.status === 201) return { success: true, message: "Document renamed (new version created)" };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Rename failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Create Collection ─────────────────────────────────────────────

  async createCollection(params: {
    name: string;
    documents?: string[];
    users?: string[];
    groups?: string[];
    public?: boolean;
  }): Promise<unknown> {
    this.cache.invalidate("colls:");
    return this.jsonRequest("/collections", {
      method: "POST",
      body: params,
    });
  }

  // ─── Workflows ─────────────────────────────────────────────────────

  async createWorkflow(params: {
    type: "read" | "approval" | "metadata-form";
    documentId: string;
    documentVersion: number;
    users?: string[];
    groups?: string[];
    confirmationMode?: "one" | "all";
    comment?: string;
    shareDocumentWithUsers?: boolean;
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      type: params.type,
      "document-id": params.documentId,
      "document-version": params.documentVersion,
    };
    if (params.users) body.users = params.users;
    if (params.groups) body.groups = params.groups;
    if (params.confirmationMode) body["confirmation-mode"] = params.confirmationMode;
    if (params.comment) body.comment = params.comment;
    if (params.shareDocumentWithUsers !== undefined)
      body["share-document-with-users"] = params.shareDocumentWithUsers;

    return this.jsonRequest("/workflows", { method: "POST", body });
  }

  async getWorkflow(workflowId: string): Promise<unknown> {
    return this.jsonRequest(`/workflow/${workflowId}`);
  }

  async getWorkflows(params?: {
    documentId?: string;
    role?: "creator" | "responder";
    status?: "started" | "completed";
    types?: string;
  }): Promise<unknown> {
    const query = new URLSearchParams();
    if (params?.documentId) query.set("document-id", params.documentId);
    if (params?.role) query.set("role", params.role);
    if (params?.status) query.set("status", params.status);
    if (params?.types) query.set("types", params.types);
    const qs = query.toString();
    return this.jsonRequest(`/workflows${qs ? "?" + qs : ""}`);
  }

  async respondToWorkflow(
    workflowId: string,
    result: "confirmed" | "rejected",
    documentVersion: number,
    comment?: string
  ): Promise<unknown> {
    const params: Record<string, unknown> = {
      result,
      "document-version": documentVersion,
    };
    if (comment) params.comment = comment;

    const res = await this.request(`/workflow/${workflowId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "respond", params }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Workflow respond failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Bulk Operations (native CenterDevice API) ─────────────────────

  /**
   * Bulk delete documents (move to trash). Native API: POST /documents action=delete
   */
  async bulkDeleteDocuments(documentIds: string[]): Promise<unknown> {
    for (const id of documentIds) this.cache.invalidate(`doc:${id}`);

    const res = await this.request("/documents?include-error-info=true", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        action: "delete",
        params: { documents: documentIds },
      }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true, total: documentIds.length, failed: 0 };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bulk delete failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  /**
   * Bulk add tags to multiple documents. Native API: POST /documents action=add-tag
   */
  async bulkAddTags(documentIds: string[], tags: string[]): Promise<unknown> {
    for (const id of documentIds) this.cache.invalidate(`doc:${id}`);

    const res = await this.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        action: "add-tag",
        params: { documents: documentIds, tags },
      }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true, total: documentIds.length, failed: 0 };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bulk add tags failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  /**
   * Bulk remove tags from multiple documents. Native API: POST /documents action=remove-tag
   */
  async bulkRemoveTags(documentIds: string[], tags: string[]): Promise<unknown> {
    for (const id of documentIds) this.cache.invalidate(`doc:${id}`);

    const res = await this.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        action: "remove-tag",
        params: { documents: documentIds, tags },
      }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true, total: documentIds.length, failed: 0 };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bulk remove tags failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  /**
   * Bulk share documents with users/groups. Native API: POST /documents action=share
   */
  async bulkShareDocuments(
    documentIds: string[],
    users?: string[],
    groups?: string[],
    comment?: string
  ): Promise<unknown> {
    for (const id of documentIds) this.cache.invalidate(`doc:${id}`);
    const params: Record<string, unknown> = { documents: documentIds };
    if (users) params.users = users;
    if (groups) params.groups = groups;
    if (comment) params.comment = comment;

    const res = await this.request("/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "share", params }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true, total: documentIds.length, failed: 0 };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Bulk share failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Unshare Document ──────────────────────────────────────────────
  // API 5.2.25: POST /document/<id> { action: "unshare", params: { users, emails, groups } }

  async unshareDocument(
    documentId: string,
    users?: string[],
    emails?: string[],
    groups?: string[]
  ): Promise<unknown> {
    const params: Record<string, unknown> = {};
    if (users) params.users = users;
    if (emails) params.emails = emails;
    if (groups) params.groups = groups;

    const res = await this.request(`/document/${documentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "unshare", params }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Unshare failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Copy Document ─────────────────────────────────────────────────
  // API 5.2.38: POST /document/<id> { action: "copy", params: { filename, collection?, folder? } }

  async copyDocument(
    documentId: string,
    filename: string,
    collection?: string,
    folder?: string
  ): Promise<unknown> {
    const params: Record<string, unknown> = { filename };
    if (collection) params.collection = collection;
    if (folder) params.folder = folder;

    return this.jsonRequest(`/document/${documentId}`, {
      method: "POST",
      body: { action: "copy", params },
    });
  }

  // ─── Remove Documents from Folder ──────────────────────────────────
  // API 5.4.5: POST /folder/<id> { action: "remove-documents", params: { documents, remove-from-collection? } }

  async removeDocumentsFromFolder(
    folderId: string,
    documents: string[],
    removeFromCollection?: boolean
  ): Promise<unknown> {
    const params: Record<string, unknown> = { documents };
    if (removeFromCollection !== undefined)
      params["remove-from-collection"] = removeFromCollection;

    const res = await this.request(`/folder/${folderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "remove-documents", params }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Remove from folder failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Delete Folder ─────────────────────────────────────────────────
  // API 5.4.9: DELETE /folder/<id>

  async deleteFolder(folderId: string): Promise<unknown> {
    const res = await this.request(`/folder/${folderId}`, {
      method: "DELETE",
    });
    if (res.status === 204) return { success: true, message: "Folder deleted" };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Delete folder failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Add Documents to Collection ───────────────────────────────────
  // API 5.3.3: POST /collection/<id> { action: "add-documents", params: { documents } }

  async addDocumentsToCollection(
    collectionId: string,
    documents: string[]
  ): Promise<unknown> {
    const res = await this.request(`/collection/${collectionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "add-documents", params: { documents } }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Add to collection failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Remove Documents from Collection ──────────────────────────────
  // API 5.3.4: POST /collection/<id> { action: "remove-documents", params: { documents } }

  async removeDocumentsFromCollection(
    collectionId: string,
    documents: string[]
  ): Promise<unknown> {
    const res = await this.request(`/collection/${collectionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "remove-documents", params: { documents } }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Remove from collection failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Comments ──────────────────────────────────────────────────────
  // API 5.5.1: POST /document/<id>/comments { text }
  // API 5.5.5: GET /document/<id>/comments

  async addComment(documentId: string, text: string): Promise<unknown> {
    return this.jsonRequest(`/document/${documentId}/comments`, {
      method: "POST",
      body: { text },
    });
  }

  async getComments(documentId: string): Promise<unknown> {
    return this.jsonRequest(`/document/${documentId}/comments`);
  }

  // ─── Delete Comment ────────────────────────────────────────────────
  // API 5.5.3: DELETE /document/<doc-id>/comment/<comment-id>

  async deleteComment(documentId: string, commentId: string): Promise<unknown> {
    const res = await this.request(`/document/${documentId}/comment/${commentId}`, {
      method: "DELETE",
    });
    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Delete comment failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Trash ─────────────────────────────────────────────────────────
  // API 5.19.1: GET /trash
  // API 5.19.2: POST /trash { action: "search", params: {...} }
  // API 5.19.3: POST /trash { action: "restore-documents", params: { documents } }

  async listTrash(offset?: number, rows?: number): Promise<unknown> {
    const query = new URLSearchParams();
    if (offset !== undefined) query.set("offset", String(offset));
    if (rows !== undefined) query.set("rows", String(rows));
    const qs = query.toString();
    return this.jsonRequest(`/trash${qs ? "?" + qs : ""}`);
  }

  async searchTrash(params: {
    query?: string;
    extensions?: string[];
    tags?: string[];
    offset?: number;
    rows?: number;
  }): Promise<unknown> {
    const searchParams: Record<string, unknown> = {};
    if (params.query) searchParams.query = { text: params.query };
    const filter: Record<string, unknown> = {};
    if (params.extensions) filter.extensions = params.extensions;
    if (params.tags) filter.tags = params.tags;
    if (Object.keys(filter).length > 0) searchParams.filter = filter;
    if (params.offset !== undefined) searchParams.offset = params.offset;
    searchParams.rows = params.rows || 20;

    return this.jsonRequest("/trash", {
      method: "POST",
      body: { action: "search", params: searchParams },
    });
  }

  async restoreFromTrash(documents: string[]): Promise<unknown> {
    const res = await this.request("/trash", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ action: "restore-documents", params: { documents } }),
      accept: "application/json",
    });
    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Restore failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Delete Workflow ───────────────────────────────────────────────
  // API 5.20.5: DELETE /workflow/<id>

  async deleteWorkflow(workflowId: string): Promise<unknown> {
    const res = await this.request(`/workflow/${workflowId}`, {
      method: "DELETE",
    });
    if (res.status === 204) return { success: true, message: "Workflow deleted" };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Delete workflow failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  // ─── Split Document ────────────────────────────────────────────────

  async splitDocument(params: {
    documentId: string;
    splits: { pages: string; filename: string }[];
    deleteOriginal?: boolean;
    collections?: string[];
    folders?: string[];
    tags?: string[];
  }): Promise<{ results: { filename: string; documentId: string; pages: string }[]; originalDeleted: boolean; inheritedTags: string[] }> {
    const { PDFDocument } = await import("pdf-lib");

    // 1. Fetch source document metadata to inherit tags
    const sourceMeta = await this.getDocumentMetadata(params.documentId) as {
      tags?: string[];
      collections?: { id: string }[];
    };
    const sourceTags = sourceMeta.tags || [];

    // Merge: source tags + caller-provided tags (deduplicated)
    const allTags = [...new Set([...sourceTags, ...(params.tags || [])])];

    // If no collections specified, inherit from source
    const collections = params.collections ||
      (sourceMeta.collections?.map(c => c.id) || []);

    // 2. Download the original PDF
    const { data } = await this.downloadDocument(params.documentId);
    const srcDoc = await PDFDocument.load(data);
    const totalPages = srcDoc.getPageCount();

    // Extract PDF-internal metadata from original
    const title = srcDoc.getTitle();
    const author = srcDoc.getAuthor();
    const subject = srcDoc.getSubject();
    const keywords = srcDoc.getKeywords();
    const creator = srcDoc.getCreator();
    const producer = srcDoc.getProducer();
    let creationDate: Date | undefined;
    let modificationDate: Date | undefined;
    try { creationDate = srcDoc.getCreationDate(); } catch { /* malformed PDF date */ }
    try { modificationDate = srcDoc.getModificationDate(); } catch { /* malformed PDF date */ }

    const results: { filename: string; documentId: string; pages: string }[] = [];

    // 3. For each split, create a new PDF
    for (const split of params.splits) {
      const pageIndices = this.parsePageRanges(split.pages, totalPages);
      const newDoc = await PDFDocument.create();

      // Copy pages
      const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
      for (const page of copiedPages) {
        newDoc.addPage(page);
      }

      // Copy PDF-internal metadata from original
      if (title) newDoc.setTitle(title);
      if (author) newDoc.setAuthor(author);
      if (subject) newDoc.setSubject(subject);
      if (keywords) newDoc.setKeywords([keywords]);
      if (creator) newDoc.setCreator(creator);
      if (producer) newDoc.setProducer(producer);
      if (creationDate) newDoc.setCreationDate(creationDate);
      if (modificationDate) newDoc.setModificationDate(modificationDate);

      const pdfBytes = await newDoc.save();
      const pdfBuffer = Buffer.from(pdfBytes);

      // 4. Upload to CenterDevice with inherited tags + collections
      const uploadResult = await this.uploadDocument({
        filename: split.filename,
        data: pdfBuffer,
        contentType: "application/pdf",
        collections,
        folders: params.folders,
        tags: allTags.length > 0 ? allTags : undefined,
      }) as { id?: string; location?: string };

      const docId = uploadResult.id || uploadResult.location?.split("/").pop() || "unknown";
      results.push({ filename: split.filename, documentId: docId, pages: split.pages });
    }

    // 5. Optionally delete original
    let originalDeleted = false;
    if (params.deleteOriginal) {
      await this.deleteDocument(params.documentId);
      originalDeleted = true;
    }

    return { results, originalDeleted, inheritedTags: sourceTags };
  }

  // ─── Merge Documents ───────────────────────────────────────────────

  async mergeDocuments(params: {
    documentIds: string[];
    filename: string;
    collections?: string[];
    folders?: string[];
    tags?: string[];
  }): Promise<{ filename: string; documentId: string; pageCount: number; inheritedTags: string[] }> {
    const { PDFDocument } = await import("pdf-lib");

    // 1. Fetch metadata from all source documents to inherit tags
    const allSourceMeta = await Promise.all(
      params.documentIds.map(id => this.getDocumentMetadata(id) as Promise<{
        tags?: string[];
        collections?: { id: string }[];
      }>)
    );

    // Collect all tags from all source docs + caller-provided (deduplicated)
    const sourceTags = allSourceMeta.flatMap(m => m.tags || []);
    const allTags = [...new Set([...sourceTags, ...(params.tags || [])])];

    // If no collections specified, inherit from first source doc
    const collections = params.collections ||
      (allSourceMeta[0]?.collections?.map(c => c.id) || []);

    // 2. Download all PDFs
    const downloads = await Promise.all(
      params.documentIds.map(id => this.downloadDocument(id))
    );

    // 3. Create merged document
    const mergedDoc = await PDFDocument.create();

    // Copy PDF-internal metadata from the first document
    const firstDoc = await PDFDocument.load(downloads[0].data);
    const title = firstDoc.getTitle();
    const author = firstDoc.getAuthor();
    const subject = firstDoc.getSubject();
    const keywords = firstDoc.getKeywords();
    const creator = firstDoc.getCreator();
    const producer = firstDoc.getProducer();
    let creationDate: Date | undefined;
    let modificationDate: Date | undefined;
    try { creationDate = firstDoc.getCreationDate(); } catch { /* malformed PDF date */ }
    try { modificationDate = firstDoc.getModificationDate(); } catch { /* malformed PDF date */ }

    if (title) mergedDoc.setTitle(title);
    if (author) mergedDoc.setAuthor(author);
    if (subject) mergedDoc.setSubject(subject);
    if (keywords) mergedDoc.setKeywords([keywords]);
    if (creator) mergedDoc.setCreator(creator);
    if (producer) mergedDoc.setProducer(producer);
    if (creationDate) mergedDoc.setCreationDate(creationDate);
    if (modificationDate) mergedDoc.setModificationDate(modificationDate);

    // 4. Copy all pages from each document in order
    for (const download of downloads) {
      const srcDoc = await PDFDocument.load(download.data);
      const indices = Array.from({ length: srcDoc.getPageCount() }, (_, i) => i);
      const copiedPages = await mergedDoc.copyPages(srcDoc, indices);
      for (const page of copiedPages) {
        mergedDoc.addPage(page);
      }
    }

    const pdfBytes = await mergedDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    // 5. Upload merged PDF with inherited tags + collections
    const uploadResult = await this.uploadDocument({
      filename: params.filename,
      data: pdfBuffer,
      contentType: "application/pdf",
      collections,
      folders: params.folders,
      tags: allTags.length > 0 ? allTags : undefined,
    }) as { id?: string; location?: string };

    const docId = uploadResult.id || uploadResult.location?.split("/").pop() || "unknown";

    return {
      filename: params.filename,
      documentId: docId,
      pageCount: mergedDoc.getPageCount(),
      inheritedTags: sourceTags,
    };
  }

  // ─── Helper: parse page ranges like "1-3,5,7-9" ───────────────────

  private parsePageRanges(rangeStr: string, totalPages: number): number[] {
    const indices: number[] = [];
    const parts = rangeStr.split(",").map(s => s.trim());

    for (const part of parts) {
      if (part.includes("-")) {
        const [startStr, endStr] = part.split("-");
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        for (let i = start; i <= end && i <= totalPages; i++) {
          indices.push(i - 1); // 0-indexed
        }
      } else {
        const page = parseInt(part, 10);
        if (page >= 1 && page <= totalPages) {
          indices.push(page - 1);
        }
      }
    }

    return indices;
  }
}
