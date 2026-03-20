/**
 * CenterDevice MCP Tools — 55 tools
 *
 * Uses @mcp-stack/core's createToolRegistrar for automatic:
 *   - try/catch + error formatting
 *   - JSON.stringify of results
 *   - Timing (duration_ms in logs)
 *   - `reason` param injection for write tools
 *   - Audit logging for all write operations
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createToolRegistrar, type Logger, type AuditLogger } from "@mcp-stack/core";
import type { CenterDeviceClient } from "./client.js";

// ─── Tool Classification ─────────────────────────────────────────────

const WRITE_TOOLS = new Set([
  "move_documents", "add_documents_to_folder", "rename_document", "delete_document",
  "add_tags", "remove_tags", "share_document", "upload_document", "upload_text_document",
  "upload_new_version", "update_text_document", "create_folder", "rename_folder",
  "move_folder", "delete_folder", "create_collection", "create_workflow",
  "respond_to_workflow", "delete_workflow", "split_document", "merge_documents",
  "batch_rename_documents", "batch_rename_folders", "batch_delete_documents",
  "batch_add_tags", "batch_remove_tags", "batch_share_documents",
  "batch_move_to_folders", "batch_create_folders", "unshare_document",
  "copy_document", "remove_documents_from_folder", "remove_documents_from_collection",
  "add_documents_to_collection", "add_comment", "delete_comment",
]);

const REASON_REQUIRED = new Set([
  "move_documents", "delete_document", "rename_document", "split_document",
  "batch_delete_documents", "delete_folder",
]);

// ─── Registration ────────────────────────────────────────────────────

export function registerTools(
  server: McpServer,
  cd: CenterDeviceClient,
  logger: Logger,
  audit?: AuditLogger,
) {
  const { tool } = createToolRegistrar(server, {
    logger,
    audit,
    writeTools: WRITE_TOOLS,
    reasonRequired: REASON_REQUIRED,
  });

  // ── Search & Read ──────────────────────────────────────────────────

  tool("search_documents",
    "Search for documents in CenterDevice using fulltext search and/or filters.",
    {
      query: z.string().optional().describe("Fulltext search query"),
      collection: z.string().optional().describe("Filter by collection ID"),
      tags: z.array(z.string()).optional().describe("Filter by tags (AND-semantic)"),
      extensions: z.array(z.string()).optional().describe("Filter by file extensions"),
      offset: z.number().optional().describe("Pagination offset (default 0)"),
      rows: z.number().optional().describe("Results to return (default 20, max 500)"),
    },
    (p) => cd.searchDocuments(p),
  );

  tool("get_document_metadata",
    "Retrieve detailed metadata for a single document by its ID.",
    {
      document_id: z.string().describe("The document ID"),
      includes: z.array(z.string()).optional().describe("Fields to include, e.g. ['filename','tags','versions']"),
    },
    (p) => cd.getDocumentMetadata(p.document_id, p.includes),
  );

  tool("list_documents",
    "List documents by collection, folder, or specific IDs.",
    {
      ids: z.array(z.string()).optional().describe("Specific document IDs"),
      collection: z.string().optional().describe("Collection ID"),
      folder: z.string().optional().describe("Folder ID"),
      offset: z.number().optional().describe("Pagination offset"),
      rows: z.number().optional().describe("Results (max 500)"),
    },
    (p) => cd.getDocuments(p),
  );

  tool("get_document_fulltext",
    "Download the extracted fulltext content of a document.",
    {
      document_id: z.string().describe("The document ID"),
      version: z.number().optional().describe("Version number (latest if omitted)"),
    },
    (p) => cd.getDocumentFulltext(p.document_id, p.version),
  );

  // ── Composite: Find and Read ───────────────────────────────────────

  tool("find_and_read",
    "Search for documents and return their fulltext content in one call.",
    {
      query: z.string().optional().describe("Fulltext search query"),
      collection: z.string().optional().describe("Collection ID"),
      tags: z.array(z.string()).optional().describe("Tags filter"),
      max_documents: z.number().optional().describe("Max docs to read (default 3, max 10)"),
    },
    async (p) => {
      const max = Math.min(p.max_documents || 3, 10);
      const searchResult = await cd.searchDocuments({
        query: p.query, collection: p.collection, tags: p.tags, rows: max,
      }) as { documents?: { id: string; filename: string }[] };

      const docs = searchResult.documents || [];
      const results = await Promise.all(
        docs.slice(0, max).map(async (doc) => {
          try {
            const text = await cd.getDocumentFulltext(doc.id);
            return { id: doc.id, filename: doc.filename, fulltext: text };
          } catch (e: unknown) {
            return { id: doc.id, filename: doc.filename, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return { total: docs.length, documents: results };
    },
  );

  // ── Collections ────────────────────────────────────────────────────

  tool("get_collection", "Retrieve details of a specific collection.",
    { collection_id: z.string().describe("The collection ID") },
    (p) => cd.getCollection(p.collection_id),
  );

  tool("list_collections", "List all collections visible to the current user.", {},
    () => cd.getCollections(),
  );

  tool("create_collection", "Create a new document collection.",
    {
      name: z.string().describe("Collection name"),
      documents: z.array(z.string()).optional().describe("Initial document IDs"),
      users: z.array(z.string()).optional().describe("User IDs to share with"),
      groups: z.array(z.string()).optional().describe("Group IDs to share with"),
    },
    (p) => cd.createCollection(p),
  );

  tool("browse_collection",
    "Browse a collection by name (or ID). Shows top-level folders and root documents.",
    {
      name: z.string().optional().describe("Collection name (partial match)"),
      collection_id: z.string().optional().describe("Collection ID (exact)"),
    },
    async (p) => {
      let collId = p.collection_id;
      if (!collId && p.name) {
        const collections = await cd.getCollections() as { collections?: { id: string; name: string }[] };
        const match = (collections.collections || []).find(
          (c) => c.name.toLowerCase().includes(p.name!.toLowerCase()),
        );
        if (!match) return { error: `No collection matching "${p.name}"` };
        collId = match.id;
      }
      if (!collId) return { error: "Provide name or collection_id" };
      const [coll, folders, docs] = await Promise.all([
        cd.getCollection(collId),
        cd.getFolders({ collection: collId, parent: "none" }),
        cd.getDocuments({ collection: collId, rows: 20 }),
      ]);
      return { collection: coll, folders, documents: docs };
    },
  );

  // ── Folders ────────────────────────────────────────────────────────

  tool("get_folder", "Retrieve details of a specific folder.",
    { folder_id: z.string().describe("The folder ID") },
    (p) => cd.getFolder(p.folder_id),
  );

  tool("list_folders",
    "List folders. Filter by collection, parent, name search, path, or document.",
    {
      collection_id: z.string().optional().describe("Collection ID"),
      parent: z.string().optional().describe("Parent folder ID, or 'none' for top-level"),
      text: z.string().optional().describe("Search by name"),
      document: z.string().optional().describe("Document ID — find its folder"),
      path: z.string().optional().describe("Full folder path using /"),
      ids: z.array(z.string()).optional().describe("Specific folder IDs"),
    },
    (p) => cd.getFolders({ collection: p.collection_id, parent: p.parent, text: p.text, document: p.document, path: p.path, ids: p.ids }),
  );

  tool("get_folder_contents",
    "Get a folder's details plus all documents and subfolders inside it.",
    { folder_id: z.string().describe("The folder ID") },
    async (p) => {
      const [folder, subfolders, docs] = await Promise.all([
        cd.getFolder(p.folder_id),
        cd.getFolders({ parent: p.folder_id }),
        cd.getDocuments({ folder: p.folder_id, rows: 500 }),
      ]);
      return { folder, subfolders, documents: docs };
    },
  );

  tool("create_folder", "Create a new folder in a collection.",
    {
      name: z.string().describe("Folder name"),
      collection: z.string().optional().describe("Collection ID (required if no parent)"),
      parent: z.string().optional().describe("Parent folder ID, or 'none' for top-level"),
    },
    (p) => cd.createFolder(p),
  );

  tool("rename_folder", "Rename an existing folder.",
    {
      folder_id: z.string().describe("The folder ID"),
      name: z.string().describe("New folder name"),
    },
    (p) => cd.renameFolder(p.folder_id, p.name),
  );

  tool("move_folder", "Move a folder to a different parent or collection.",
    {
      folder_id: z.string().describe("Folder ID to move"),
      parent: z.string().describe("New parent folder ID, or 'none' for top-level"),
      collection: z.string().optional().describe("Destination collection ID"),
    },
    (p) => cd.moveFolder(p.folder_id, { parent: p.parent, collection: p.collection }),
  );

  tool("delete_folder", "Delete a folder and all its subfolders.",
    { folder_id: z.string().describe("The folder ID") },
    (p) => cd.deleteFolder(p.folder_id),
  );

  // ── Document Operations ────────────────────────────────────────────

  tool("rename_document", "Rename a document (creates new version).",
    {
      document_id: z.string().describe("The document ID"),
      filename: z.string().describe("New filename"),
    },
    (p) => cd.renameDocument(p.document_id, p.filename),
  );

  tool("delete_document", "Delete a document (moves to trash).",
    { document_id: z.string().describe("The document ID") },
    (p) => cd.deleteDocument(p.document_id),
  );

  tool("copy_document", "Create a copy of a document.",
    {
      document_id: z.string().describe("Source document ID"),
      filename: z.string().describe("Filename for the copy"),
      collection: z.string().optional().describe("Target collection ID"),
      folder: z.string().optional().describe("Target folder ID"),
    },
    (p) => cd.copyDocument(p.document_id, p.filename, p.collection, p.folder),
  );

  tool("move_documents", "Move documents from one collection/folder to another.",
    {
      documents: z.array(z.string()).describe("Document IDs to move"),
      source_collection: z.string().optional().describe("Source collection ID"),
      source_folder: z.string().optional().describe("Source folder ID ('none' for root)"),
      destination_collection: z.string().optional().describe("Destination collection ID"),
      destination_folder: z.string().optional().describe("Destination folder ID"),
    },
    (p) => cd.moveDocuments({
      documents: p.documents,
      sourceCollection: p.source_collection,
      sourceFolder: p.source_folder,
      destinationCollection: p.destination_collection,
      destinationFolder: p.destination_folder,
    }),
  );

  tool("add_documents_to_folder", "Add documents to a folder.",
    {
      folder_id: z.string().describe("Target folder ID"),
      documents: z.array(z.string()).describe("Document IDs to add"),
    },
    (p) => cd.addDocumentsToFolder(p.folder_id, p.documents),
  );

  tool("remove_documents_from_folder", "Remove documents from a folder.",
    {
      folder_id: z.string().describe("The folder ID"),
      documents: z.array(z.string()).describe("Document IDs to remove"),
      remove_from_collection: z.boolean().optional().describe("Also remove from collection"),
    },
    (p) => cd.removeDocumentsFromFolder(p.folder_id, p.documents, p.remove_from_collection),
  );

  tool("add_documents_to_collection", "Add documents to a collection.",
    {
      collection_id: z.string().describe("Target collection ID"),
      documents: z.array(z.string()).describe("Document IDs"),
    },
    (p) => cd.addDocumentsToCollection(p.collection_id, p.documents),
  );

  tool("remove_documents_from_collection", "Remove documents from a collection.",
    {
      collection_id: z.string().describe("The collection ID"),
      documents: z.array(z.string()).describe("Document IDs"),
    },
    (p) => cd.removeDocumentsFromCollection(p.collection_id, p.documents),
  );

  // ── Upload ─────────────────────────────────────────────────────────

  tool("upload_document", "Upload a new document (base64-encoded).",
    {
      filename: z.string().describe("Filename with extension"),
      content_base64: z.string().describe("File content as base64"),
      content_type: z.string().describe("MIME type"),
      collections: z.array(z.string()).optional().describe("Collection IDs"),
      folders: z.array(z.string()).optional().describe("Folder IDs"),
      tags: z.array(z.string()).optional().describe("Tags to apply"),
    },
    (p) => cd.uploadDocument({
      filename: p.filename,
      data: Buffer.from(p.content_base64, "base64"),
      contentType: p.content_type,
      collections: p.collections,
      folders: p.folders,
      tags: p.tags,
    }),
  );

  tool("upload_text_document",
    "Upload a new text-based document (markdown, txt, json, csv, xml, html, etc.).",
    {
      filename: z.string().describe("Filename with extension"),
      content: z.string().describe("Text content (sent as UTF-8)"),
      content_type: z.string().optional().describe("MIME type (auto-detected from extension if omitted)"),
      collections: z.array(z.string()).optional().describe("Collection IDs"),
      folders: z.array(z.string()).optional().describe("Folder IDs"),
      tags: z.array(z.string()).optional().describe("Tags to apply"),
    },
    (p) => {
      const mimeMap: Record<string, string> = {
        md: "text/markdown", txt: "text/plain", json: "application/json",
        csv: "text/csv", xml: "application/xml", html: "text/html",
      };
      const ext = p.filename.split(".").pop()?.toLowerCase() || "";
      const ct = p.content_type || mimeMap[ext] || "text/plain";
      return cd.uploadDocument({
        filename: p.filename,
        data: Buffer.from(p.content, "utf-8"),
        contentType: ct,
        collections: p.collections,
        folders: p.folders,
        tags: p.tags,
      });
    },
  );

  tool("upload_new_version", "Upload a new version of an existing document (base64).",
    {
      document_id: z.string().describe("Existing document ID"),
      filename: z.string().describe("Filename"),
      content_base64: z.string().describe("File content as base64"),
      content_type: z.string().describe("MIME type"),
    },
    (p) => cd.uploadNewVersion({
      documentId: p.document_id, filename: p.filename,
      data: Buffer.from(p.content_base64, "base64"), contentType: p.content_type,
    }),
  );

  tool("update_text_document", "Upload a new version of a text document.",
    {
      document_id: z.string().describe("Existing document ID"),
      filename: z.string().describe("Filename"),
      content: z.string().describe("New text content"),
      content_type: z.string().optional().describe("MIME type"),
    },
    (p) => {
      const ext = p.filename.split(".").pop()?.toLowerCase() || "";
      const mimeMap: Record<string, string> = {
        md: "text/markdown", txt: "text/plain", json: "application/json",
        csv: "text/csv", xml: "application/xml", html: "text/html",
      };
      return cd.uploadNewVersion({
        documentId: p.document_id, filename: p.filename,
        data: Buffer.from(p.content, "utf-8"),
        contentType: p.content_type || mimeMap[ext] || "text/plain",
      });
    },
  );

  // ── Tags ───────────────────────────────────────────────────────────

  tool("add_tags", "Add tags to a document.",
    { document_id: z.string(), tags: z.array(z.string()) },
    (p) => cd.addTags(p.document_id, p.tags),
  );

  tool("remove_tags", "Remove tags from a document.",
    { document_id: z.string(), tags: z.array(z.string()) },
    (p) => cd.removeTags(p.document_id, p.tags),
  );

  // ── Sharing ────────────────────────────────────────────────────────

  tool("share_document", "Share a document with users and/or groups.",
    {
      document_id: z.string(),
      users: z.array(z.string()).optional(),
      groups: z.array(z.string()).optional(),
    },
    (p) => cd.shareDocument(p.document_id, p.users, p.groups),
  );

  tool("unshare_document", "Remove sharing from a document.",
    {
      document_id: z.string(),
      users: z.array(z.string()).optional(),
      emails: z.array(z.string()).optional(),
      groups: z.array(z.string()).optional(),
    },
    (p) => cd.unshareDocument(p.document_id, p.users, p.emails, p.groups),
  );

  // ── Comments ───────────────────────────────────────────────────────

  tool("get_comments", "Get all comments on a document.",
    { document_id: z.string() },
    (p) => cd.getComments(p.document_id),
  );

  tool("add_comment", "Add a comment to a document.",
    { document_id: z.string(), text: z.string().describe("Comment text") },
    (p) => cd.addComment(p.document_id, p.text),
  );

  tool("delete_comment", "Delete a comment from a document.",
    {
      document_id: z.string(),
      comment_id: z.string().describe("Comment ID to delete"),
    },
    (p) => cd.deleteComment(p.document_id, p.comment_id),
  );

  // ── Users ──────────────────────────────────────────────────────────

  tool("get_current_user", "Get details of the currently authenticated user.", {},
    () => cd.getCurrentUser(),
  );

  tool("list_users", "List all users visible in the current tenant.", {},
    () => cd.getUsers(),
  );

  // ── Workflows ──────────────────────────────────────────────────────

  tool("list_workflows", "List workflows (document requests).",
    {
      document_id: z.string().optional(),
      role: z.enum(["creator", "responder"]).optional(),
      status: z.enum(["started", "completed"]).optional(),
    },
    (p) => cd.getWorkflows(p),
  );

  tool("get_workflow", "Retrieve details of a workflow.",
    { workflow_id: z.string() },
    (p) => cd.getWorkflow(p.workflow_id),
  );

  tool("create_workflow", "Create a workflow (document request).",
    {
      type: z.enum(["read", "approval", "metadata-form"]),
      document_id: z.string(),
      document_version: z.number(),
      users: z.array(z.string()).optional(),
      groups: z.array(z.string()).optional(),
      confirmation_mode: z.enum(["one", "all"]).optional(),
      comment: z.string().optional(),
      share_document: z.boolean().optional(),
    },
    (p) => cd.createWorkflow({
      type: p.type, documentId: p.document_id, documentVersion: p.document_version,
      users: p.users, groups: p.groups, confirmationMode: p.confirmation_mode,
      comment: p.comment, shareDocumentWithUsers: p.share_document,
    }),
  );

  tool("respond_to_workflow", "Respond to a workflow.",
    {
      workflow_id: z.string(),
      result: z.enum(["confirmed", "rejected"]),
      document_version: z.number(),
      comment: z.string().optional(),
    },
    (p) => cd.respondToWorkflow(p.workflow_id, p.result, p.document_version, p.comment),
  );

  tool("delete_workflow", "Delete a workflow.",
    { workflow_id: z.string() },
    (p) => cd.deleteWorkflow(p.workflow_id),
  );

  // ── PDF Operations ─────────────────────────────────────────────────

  tool("split_document",
    "Split a PDF into multiple parts by page ranges. Uploads each part as a new document.",
    {
      document_id: z.string().describe("Source PDF document ID"),
      splits: z.array(z.object({
        pages: z.string().describe("Page ranges, e.g. '1-3' or '1,3,5-7'"),
        filename: z.string().describe("Filename for this split"),
      })),
      delete_original: z.boolean().optional().describe("Delete original after split"),
      collections: z.array(z.string()).optional(),
      folders: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    },
    (p) => cd.splitDocument(p),
  );

  tool("merge_documents",
    "Merge multiple PDFs into one. Documents are combined in the order given.",
    {
      document_ids: z.array(z.string()).describe("PDF document IDs to merge (in order)"),
      filename: z.string().describe("Filename for merged PDF"),
      collections: z.array(z.string()).optional(),
      folders: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    },
    (p) => cd.mergeDocuments(p),
  );

  // ── Trash ──────────────────────────────────────────────────────────

  tool("list_trash", "List documents in the trash.",
    { offset: z.number().optional(), rows: z.number().optional() },
    (p) => cd.listTrash(p.offset, p.rows),
  );

  tool("search_trash", "Search for documents in the trash.",
    {
      query: z.string().optional(),
      extensions: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      offset: z.number().optional(),
      rows: z.number().optional(),
    },
    (p) => cd.searchTrash(p),
  );

  tool("restore_from_trash", "Restore documents from trash.",
    { documents: z.array(z.string()).describe("Document IDs to restore") },
    (p) => cd.restoreFromTrash(p.documents),
  );

  // ── Batch Operations ───────────────────────────────────────────────

  tool("batch_rename_documents", "Rename multiple documents in one call.",
    {
      operations: z.array(z.object({
        document_id: z.string(),
        filename: z.string(),
      })),
    },
    async (p) => {
      const results = await Promise.all(
        p.operations.map(async (op) => {
          try {
            await cd.renameDocument(op.document_id, op.filename);
            return { id: op.document_id, status: "ok" };
          } catch (e: unknown) {
            return { id: op.document_id, status: "error", error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return { total: results.length, results };
    },
  );

  tool("batch_rename_folders", "Rename multiple folders in one call.",
    { operations: z.array(z.object({ folder_id: z.string(), name: z.string() })) },
    async (p) => {
      const results = await Promise.all(
        p.operations.map(async (op) => {
          try {
            await cd.renameFolder(op.folder_id, op.name);
            return { id: op.folder_id, status: "ok" };
          } catch (e: unknown) {
            return { id: op.folder_id, status: "error", error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return { total: results.length, results };
    },
  );

  tool("batch_delete_documents", "Delete multiple documents (move to trash).",
    { document_ids: z.array(z.string()) },
    (p) => cd.bulkDeleteDocuments(p.document_ids),
  );

  tool("batch_add_tags", "Add tags to multiple documents.",
    { document_ids: z.array(z.string()), tags: z.array(z.string()) },
    (p) => cd.bulkAddTags(p.document_ids, p.tags),
  );

  tool("batch_remove_tags", "Remove tags from multiple documents.",
    { document_ids: z.array(z.string()), tags: z.array(z.string()) },
    (p) => cd.bulkRemoveTags(p.document_ids, p.tags),
  );

  tool("batch_share_documents", "Share multiple documents.",
    {
      document_ids: z.array(z.string()),
      users: z.array(z.string()).optional(),
      groups: z.array(z.string()).optional(),
      comment: z.string().optional(),
    },
    (p) => cd.bulkShareDocuments(p.document_ids, p.users, p.groups, p.comment),
  );

  tool("batch_move_to_folders", "Move documents to multiple different folders.",
    { operations: z.array(z.object({ document_id: z.string(), folder_id: z.string() })) },
    async (p) => {
      const results = await Promise.all(
        p.operations.map(async (op) => {
          try {
            await cd.addDocumentsToFolder(op.folder_id, [op.document_id]);
            return { id: op.document_id, folder: op.folder_id, status: "ok" };
          } catch (e: unknown) {
            return { id: op.document_id, folder: op.folder_id, status: "error", error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return { total: results.length, results };
    },
  );

  tool("batch_create_folders", "Create multiple folders in one call.",
    {
      folders: z.array(z.object({
        name: z.string(),
        collection: z.string().optional(),
        parent: z.string().optional(),
      })),
    },
    async (p) => {
      const results = await Promise.all(
        p.folders.map(async (f) => {
          try {
            const result = await cd.createFolder(f);
            return { name: f.name, status: "ok", result };
          } catch (e: unknown) {
            return { name: f.name, status: "error", error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return { total: results.length, results };
    },
  );
}
