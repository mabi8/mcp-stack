/**
 * CenterDevice-specific audit detail formatter.
 *
 * Knows how to format the parameters of each CD MCP tool
 * into a human-readable summary for audit log entries.
 */

import type { AuditDetailFormatter } from "@mcp-stack/core";

export const cdAuditFormatter: AuditDetailFormatter = (tool, params) => {
  const docId = params.document_id
    || (Array.isArray(params.document_ids) ? params.document_ids[0] : undefined)
    || (Array.isArray(params.documents) ? params.documents[0] : undefined)
    || "";
  const docRef = docId ? `\`${docId}\`` : "";

  switch (tool) {
    case "move_documents":
      return `${docRef} → ${params.destination_folder || params.destination_collection || "?"}`;
    case "add_documents_to_folder":
      return `${Array.isArray(params.documents) ? params.documents.length : 0} docs → folder \`${params.folder_id}\``;
    case "rename_document":
      return `${docRef} → ${params.filename}`;
    case "rename_folder":
      return `folder \`${params.folder_id}\` → ${params.name}`;
    case "delete_document":
      return `${docRef} → trash`;
    case "delete_folder":
      return `folder \`${params.folder_id}\` → deleted`;
    case "add_tags":
      return `${docRef} + ${(params.tags as string[] || []).join(", ")}`;
    case "remove_tags":
      return `${docRef} - ${(params.tags as string[] || []).join(", ")}`;
    case "share_document":
      return `${docRef} → ${(params.users as string[] || []).length} users, ${(params.groups as string[] || []).length} groups`;
    case "split_document":
      return `${docRef} → ${Array.isArray(params.splits) ? params.splits.length : 0} parts`;
    case "merge_documents":
      return `${Array.isArray(params.document_ids) ? params.document_ids.length : 0} docs → ${params.filename}`;
    case "upload_document":
    case "upload_text_document":
      return `${params.filename} (new document)`;
    case "upload_new_version":
    case "update_text_document":
      return `${docRef} ← ${params.filename} (new version)`;
    case "create_folder":
      return `${params.name} in ${params.collection || params.parent || "?"}`;
    case "move_folder":
      return `folder \`${params.folder_id}\` → parent ${params.parent}`;
    case "create_collection":
      return `${params.name}`;
    case "create_workflow":
      return `${params.type} on ${docRef} → ${(params.users as string[] || []).length} users`;
    case "respond_to_workflow":
      return `\`${params.workflow_id}\` → ${params.result}`;
    case "delete_workflow":
      return `\`${params.workflow_id}\` → deleted`;
    case "batch_rename_documents":
      return `${Array.isArray(params.operations) ? params.operations.length : 0} renames`;
    case "batch_rename_folders":
      return `${Array.isArray(params.operations) ? params.operations.length : 0} folder renames`;
    case "batch_delete_documents":
      return `${Array.isArray(params.document_ids) ? params.document_ids.length : 0} docs → trash`;
    case "batch_add_tags":
      return `${Array.isArray(params.document_ids) ? params.document_ids.length : 0} docs + ${(params.tags as string[] || []).join(", ")}`;
    case "batch_remove_tags":
      return `${Array.isArray(params.document_ids) ? params.document_ids.length : 0} docs - ${(params.tags as string[] || []).join(", ")}`;
    case "batch_share_documents":
      return `${Array.isArray(params.document_ids) ? params.document_ids.length : 0} docs shared`;
    case "batch_move_to_folders":
      return `${Array.isArray(params.operations) ? params.operations.length : 0} moves`;
    case "batch_create_folders":
      return `${Array.isArray(params.folders) ? params.folders.length : 0} folders`;
    case "unshare_document":
      return `${docRef} unshared`;
    case "copy_document":
      return `${docRef} → copy`;
    case "remove_documents_from_folder":
      return `${Array.isArray(params.documents) ? params.documents.length : 0} docs removed from folder`;
    case "add_documents_to_collection":
    case "remove_documents_from_collection":
      return `${Array.isArray(params.documents) ? params.documents.length : 0} docs`;
    case "add_comment":
      return `${docRef} + comment: "${String(params.text || "").slice(0, 60)}"`;
    case "delete_comment":
      return `${docRef} - comment \`${params.comment_id}\``;
    default:
      return `${docRef} ${JSON.stringify(params).slice(0, 100)}`;
  }
};
