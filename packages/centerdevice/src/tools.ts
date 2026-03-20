/**
 * CenterDevice MCP Tools — 46 tools
 *
 * Collapsed from 55: batch/single pairs merged into unified tools that accept
 * one-or-many. The MCP server picks the most efficient CD API strategy internally.
 *
 * Collapsed pairs:
 *   rename_document + batch_rename_documents → rename_documents
 *   rename_folder + batch_rename_folders     → rename_folders
 *   delete_document + batch_delete_documents → delete_documents (native bulk API)
 *   add_tags + batch_add_tags               → add_tags (native bulk API)
 *   remove_tags + batch_remove_tags         → remove_tags (native bulk API)
 *   share_document + batch_share_documents  → share_documents (native bulk API)
 *   create_folder + batch_create_folders    → create_folders
 *   add_documents_to_folder + batch_move_to_folders → move_to_folders
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
  "move_documents", "move_to_folders", "rename_documents", "delete_documents",
  "add_tags", "remove_tags", "share_documents", "upload_document", "upload_text_document",
  "upload_new_version", "update_text_document", "create_folders", "rename_folders",
  "move_folder", "delete_folder", "create_collection", "create_workflow",
  "respond_to_workflow", "delete_workflow", "split_document", "merge_documents",
  "unshare_document", "copy_document", "remove_documents_from_folder",
  "remove_documents_from_collection", "add_documents_to_collection",
  "add_comment", "delete_comment",
]);

const REASON_REQUIRED = new Set([
  "move_documents", "delete_documents", "rename_documents", "split_document",
  "delete_folder",
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

  // UNIFIED: create_folders (was create_folder + batch_create_folders)
  tool("create_folders",
    "Create one or more folders. Parallel execution for multiple.",
    {
      operations: z.array(z.object({
        name: z.string().describe("Folder name"),
        collection: z.string().optional().describe("Collection ID (required if no parent)"),
        parent: z.string().optional().describe("Parent folder ID, or 'none' for top-level"),
      })).min(1),
    },
    async (p) => {
      if (p.operations.length === 1) {
        const result = await cd.createFolder(p.operations[0]);
        return { total: 1, results: [{ name: p.operations[0].name, status: "ok", result }] };
      }
      const results = await Promise.all(
        p.operations.map(async (f) => {
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

  // UNIFIED: rename_folders (was rename_folder + batch_rename_folders)
  tool("rename_folders",
    "Rename one or more folders. Parallel execution for multiple.",
    {
      operations: z.array(z.object({
        folder_id: z.string().describe("Folder ID"),
        name: z.string().describe("New folder name"),
      })).min(1),
    },
    async (p) => {
      if (p.operations.length === 1) {
        await cd.renameFolder(p.operations[0].folder_id, p.operations[0].name);
        return { total: 1, results: [{ id: p.operations[0].folder_id, status: "ok" }] };
      }
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

  // UNIFIED: rename_documents (was rename_document + batch_rename_documents)
  tool("rename_documents",
    "Rename one or more documents (each creates a new version). Parallel execution for multiple.",
    {
      operations: z.array(z.object({
        document_id: z.string().describe("Document ID"),
        filename: z.string().describe("New filename"),
      })).min(1),
    },
    async (p) => {
      if (p.operations.length === 1) {
        await cd.renameDocument(p.operations[0].document_id, p.operations[0].filename);
        return { total: 1, results: [{ id: p.operations[0].document_id, status: "ok" }] };
      }
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

  // UNIFIED: delete_documents (was delete_document + batch_delete_documents)
  tool("delete_documents",
    "Delete one or more documents (move to trash). Uses native bulk API — single HTTP call.",
    { document_ids: z.array(z.string()).min(1).describe("Document IDs to delete") },
    (p) => cd.bulkDeleteDocuments(p.document_ids),
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

  // UNIFIED: move_to_folders (was add_documents_to_folder + batch_move_to_folders)
  tool("move_to_folders",
    "Add documents to folders (within same collection). One or more operations, each moves documents into a target folder.",
    {
      operations: z.array(z.object({
        folder_id: z.string().describe("Target folder ID"),
        document_ids: z.array(z.string()).min(1).describe("Document IDs to move into this folder"),
      })).min(1),
    },
    async (p) => {
      if (p.operations.length === 1) {
        await cd.addDocumentsToFolder(p.operations[0].folder_id, p.operations[0].document_ids);
        return { total: 1, succeeded: 1, failed: 0, results: [{ folder_id: p.operations[0].folder_id, count: p.operations[0].document_ids.length, success: true }] };
      }
      const results = await Promise.all(
        p.operations.map(async (op) => {
          try {
            await cd.addDocumentsToFolder(op.folder_id, op.document_ids);
            return { folder_id: op.folder_id, count: op.document_ids.length, success: true };
          } catch (e: unknown) {
            return { folder_id: op.folder_id, count: op.document_ids.length, success: false, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return {
        total: results.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      };
    },
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
        filename: p.filename, data: Buffer.from(p.content, "utf-8"),
        contentType: ct, collections: p.collections, folders: p.folders, tags: p.tags,
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

  // ── Tags (native bulk API — always single HTTP call) ───────────────

  tool("add_tags",
    "Add tags to one or more documents. Always uses native bulk API (single HTTP call).",
    {
      document_ids: z.array(z.string()).min(1).describe("Document IDs (one or more)"),
      tags: z.array(z.string()).min(1).describe("Tags to add"),
    },
    (p) => cd.bulkAddTags(p.document_ids, p.tags),
  );

  tool("remove_tags",
    "Remove tags from one or more documents. Always uses native bulk API (single HTTP call).",
    {
      document_ids: z.array(z.string()).min(1).describe("Document IDs (one or more)"),
      tags: z.array(z.string()).min(1).describe("Tags to remove"),
    },
    (p) => cd.bulkRemoveTags(p.document_ids, p.tags),
  );

  // ── Sharing (native bulk API) ──────────────────────────────────────

  tool("share_documents",
    "Share one or more documents with users and/or groups. Always uses native bulk API.",
    {
      document_ids: z.array(z.string()).min(1).describe("Document IDs (one or more)"),
      users: z.array(z.string()).optional().describe("User IDs to share with"),
      groups: z.array(z.string()).optional().describe("Group IDs to share with"),
      comment: z.string().optional().describe("Comment for recipients"),
    },
    (p) => cd.bulkShareDocuments(p.document_ids, p.users, p.groups, p.comment),
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
    { document_id: z.string(), comment_id: z.string().describe("Comment ID to delete") },
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
    { document_id: z.string().optional(), role: z.enum(["creator", "responder"]).optional(), status: z.enum(["started", "completed"]).optional() },
    (p) => cd.getWorkflows(p),
  );

  tool("get_workflow", "Retrieve details of a workflow.",
    { workflow_id: z.string() },
    (p) => cd.getWorkflow(p.workflow_id),
  );

  tool("create_workflow", "Create a workflow (document request).",
    {
      type: z.enum(["read", "approval", "metadata-form"]),
      document_id: z.string(), document_version: z.number(),
      users: z.array(z.string()).optional(), groups: z.array(z.string()).optional(),
      confirmation_mode: z.enum(["one", "all"]).optional(),
      comment: z.string().optional(), share_document: z.boolean().optional(),
    },
    (p) => cd.createWorkflow({
      type: p.type, documentId: p.document_id, documentVersion: p.document_version,
      users: p.users, groups: p.groups, confirmationMode: p.confirmation_mode,
      comment: p.comment, shareDocumentWithUsers: p.share_document,
    }),
  );

  tool("respond_to_workflow", "Respond to a workflow.",
    { workflow_id: z.string(), result: z.enum(["confirmed", "rejected"]), document_version: z.number(), comment: z.string().optional() },
    (p) => cd.respondToWorkflow(p.workflow_id, p.result, p.document_version, p.comment),
  );

  tool("delete_workflow", "Delete a workflow.",
    { workflow_id: z.string() },
    (p) => cd.deleteWorkflow(p.workflow_id),
  );

  // ── PDF Operations ─────────────────────────────────────────────────

  tool("split_document",
    "Split a PDF into multiple parts by page ranges.",
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
    (p) => cd.splitDocument({
      documentId: p.document_id,
      splits: p.splits,
      deleteOriginal: p.delete_original,
      collections: p.collections,
      folders: p.folders,
      tags: p.tags,
    }),
  );

  tool("merge_documents",
    "Merge multiple PDFs into one.",
    {
      document_ids: z.array(z.string()).describe("PDF document IDs to merge (in order)"),
      filename: z.string().describe("Filename for merged PDF"),
      collections: z.array(z.string()).optional(),
      folders: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    },
    (p) => cd.mergeDocuments({
      documentIds: p.document_ids,
      filename: p.filename,
      collections: p.collections,
      folders: p.folders,
      tags: p.tags,
    }),
  );

  // ── Trash ──────────────────────────────────────────────────────────
  // list_trash removed — search_trash with no params does the same thing

  tool("search_trash", "Search or list documents in the trash. All params optional — omit all to list everything.",
    { query: z.string().optional(), extensions: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), offset: z.number().optional(), rows: z.number().optional() },
    (p) => cd.searchTrash(p),
  );

  tool("restore_from_trash", "Restore documents from trash.",
    { documents: z.array(z.string()).describe("Document IDs to restore") },
    (p) => cd.restoreFromTrash(p.documents),
  );
}
