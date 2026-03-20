/**
 * Bidrento MCP Tools — 40 tools
 *
 * Uses @mcp-stack/core's createToolRegistrar for automatic error handling,
 * JSON serialization, timing, and logging.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createToolRegistrar, type Logger } from "@mcp-stack/core";
import type { BidrentoClient } from "./client.js";

const WRITE_TOOLS = new Set([
  "add_tenant", "add_rental_agreement", "update_rental_agreement",
  "terminate_rental_agreement", "add_rental_agreement_price_change",
  "update_rental_agreement_price_change", "create_invoice",
  "add_meter_reading", "add_meter_for_rental_object", "add_meter_for_building",
  "add_service_request", "apply_for_listings", "report_event_for_rental_object",
]);

export function registerTools(server: McpServer, client: BidrentoClient, logger: Logger) {
  const { tool } = createToolRegistrar(server, {
    logger,
    writeTools: WRITE_TOOLS,
  });

  // ── Buildings ──────────────────────────────────────────────────────

  tool("list_buildings", "List all buildings in the portfolio.", {},
    () => client.listBuildings());

  // ── Rental Objects ─────────────────────────────────────────────────

  tool("list_rental_objects", "List all rental objects (units/apartments) across the portfolio.", {},
    () => client.listRentalObjects());

  tool("list_rental_objects_by_building", "List rental objects within a specific building.",
    { building_id: z.number().int().positive().describe("Building ID") },
    (p) => client.listRentalObjectsByBuilding(p.building_id));

  tool("check_objects_available",
    "Check availability of rental objects. Pass comma-separated IDs or omit to check all.",
    { ids: z.string().optional().describe("Comma-separated IDs, e.g. '1,2,3'") },
    (p) => client.checkObjectsAvailable(p.ids));

  tool("check_objects_available_for_building", "Check availability of all rental objects in a building.",
    { building_id: z.number().int().positive() },
    (p) => client.checkObjectsAvailableForBuilding(p.building_id));

  tool("report_event_for_rental_object", "Send a push-notification event to a rental object.",
    { rental_object_id: z.number().int().positive() },
    (p) => client.reportEventForRentalObject(p.rental_object_id));

  // ── Tenants ────────────────────────────────────────────────────────

  tool("list_tenants", "List all tenants in the account.", {},
    () => client.listTenants());

  tool("check_tenant_email", "Check if an email is already registered as a tenant.",
    { email: z.string().email() },
    (p) => client.checkTenantEmail(p.email));

  tool("check_email", "General email existence check in Bidrento.",
    { email: z.string().email() },
    (p) => client.checkEmail(p.email));

  tool("add_tenant", "Create a new tenant (natural person or legal entity).",
    {
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      personal_code: z.string().optional(),
      legal_entity: z.boolean().optional(),
      legal_entity_name: z.string().optional(),
      legal_entity_representative_first_name: z.string().optional(),
      legal_entity_representative_last_name: z.string().optional(),
      legal_entity_representative_personal_code: z.string().optional(),
      added_as_co_tenant: z.boolean().optional(),
      country: z.string().optional(),
      county: z.string().optional(),
      city: z.string().optional(),
      street: z.string().optional(),
    },
    (p) => client.addTenant(p));

  // ── Rental Agreements ──────────────────────────────────────────────

  tool("list_rental_agreements", "List all rental agreements, optionally filtered by date range.",
    {
      filter_start: z.string().optional().describe("'YYYY-MM-DD'"),
      filter_end: z.string().optional().describe("'YYYY-MM-DD'"),
    },
    (p) => client.listRentalAgreements(p));

  tool("get_rental_agreement", "Get a single rental agreement by UUID.",
    { uuid: z.string().describe("Rental agreement UUID") },
    (p) => client.getRentalAgreement(p.uuid));

  tool("list_rental_agreements_by_object", "List rental agreements for a specific rental object.",
    {
      rental_object_id: z.number().int().positive(),
      filter_start: z.string().optional().describe("'YYYY-MM-DD'"),
      filter_end: z.string().optional().describe("'YYYY-MM-DD'"),
    },
    (p) => client.listRentalAgreementsByObject(p.rental_object_id, {
      filter_start: p.filter_start, filter_end: p.filter_end,
    }));

  tool("update_rental_agreement", "Update an existing rental agreement by UUID.",
    {
      uuid: z.string().describe("Rental agreement UUID"),
      agreement_end: z.string().optional(),
      payment_amount: z.number().optional(),
      agreement_type: z.enum(["termless", "fixed_term", "prepayment", "accommodation"]).optional(),
      payment_frequency: z.enum(["monthly", "weekly"]).optional(),
      payment_date: z.number().int().optional(),
      invoice_date: z.number().int().optional(),
      interest_rate: z.number().optional(),
      automatic_invoice: z.boolean().optional(),
      automatic_send_invoice: z.boolean().optional(),
      rent_amount_contains_vat: z.boolean().optional(),
    },
    (p) => {
      const { uuid, ...body } = p;
      return client.updateRentalAgreement(uuid, body);
    });

  tool("add_rental_agreement", "Create a new rental agreement between a tenant and a rental object.",
    {
      rental_object: z.number().int().describe("Rental object ID"),
      tenant: z.number().int().describe("Tenant ID"),
      agreement_date: z.string().describe("'YYYY-MM-DD'"),
      payment_amount: z.number().describe("Monthly rent"),
      deposit: z.number().describe("Deposit amount"),
      co_tenants: z.string().optional(),
      agreement_end: z.string().optional(),
      rental_period_start_date: z.string().optional(),
      agreement_type: z.enum(["termless", "fixed_term", "prepayment", "accommodation"]).optional(),
      payment_frequency: z.enum(["monthly", "weekly"]).optional(),
      payment_date: z.number().int().optional(),
      pre_payment: z.number().optional(),
      invoice_date: z.number().int().optional(),
      interest_rate: z.number().optional(),
      create_first_rent_invoice: z.boolean().optional(),
      automatic_invoice: z.boolean().optional(),
      automatic_send_invoice: z.boolean().optional(),
      status: z.enum(["active", "draft"]).optional(),
      rent_amount_contains_vat: z.boolean().optional(),
    },
    (p) => client.addRentalAgreement(p));

  tool("terminate_rental_agreement", "Terminate an active rental agreement.",
    {
      uuid: z.string().describe("Rental agreement UUID"),
      end_date: z.string().describe("'YYYY-MM-DD'"),
      delete_unsent_rent_invoices: z.boolean().optional(),
    },
    (p) => client.terminateRentalAgreement(p));

  // ── Price Changes ──────────────────────────────────────────────────

  tool("get_rental_agreement_price_changes", "Get scheduled price changes for a rental agreement.",
    { uuid: z.string().describe("Rental agreement UUID") },
    (p) => client.getRentalAgreementPriceChanges(p.uuid));

  tool("add_rental_agreement_price_change", "Add a price change schedule to a rental agreement.",
    {
      uuid: z.string().describe("Rental agreement UUID"),
      new_amount: z.number().describe("New payment amount"),
      change_date: z.string().describe("'YYYY-MM-DD'"),
    },
    (p) => {
      const { uuid, ...body } = p;
      return client.addRentalAgreementPriceChange(uuid, body);
    });

  tool("update_rental_agreement_price_change", "Update an existing price change by its ID.",
    {
      id: z.number().int().describe("Price change ID"),
      new_amount: z.number().optional(),
      change_date: z.string().optional(),
    },
    (p) => {
      const { id, ...body } = p;
      return client.updateRentalAgreementPriceChange(id, body);
    });

  // ── Invoices ───────────────────────────────────────────────────────

  tool("list_invoices", "List invoices, optionally filtered by rental agreement UUID.",
    { rental_agreement_uuid: z.string().optional() },
    (p) => client.listInvoices(p.rental_agreement_uuid));

  tool("create_invoice", "Manually create an invoice.",
    {
      rental_agreement_uuid: z.string().describe("Rental agreement UUID"),
      amount: z.number().describe("Invoice amount"),
      description: z.string().optional(),
      due_date: z.string().optional().describe("'YYYY-MM-DD'"),
    },
    (p) => client.createInvoice(p));

  // ── Meters ─────────────────────────────────────────────────────────

  tool("list_meters", "List all utility meters in the portfolio.", {},
    () => client.listMeters());

  tool("list_meters_by_rental_object", "List utility meters for a specific rental object.",
    { rental_object_id: z.number().int().positive() },
    (p) => client.listMetersByRentalObject(p.rental_object_id));

  tool("list_meter_types", "List all available meter types.", {},
    () => client.listMeterTypes());

  tool("list_meter_unit_types", "List all available meter unit types (kWh, m³, etc.).", {},
    () => client.listMeterUnitTypes());

  tool("add_meter_reading", "Submit a new meter reading.",
    {
      meter_id: z.number().int().describe("Meter ID"),
      date: z.string().describe("'YYYY-MM-DD'"),
      period: z.string().describe("Reading period"),
      amount: z.string().optional().describe("Absolute reading"),
      consumption: z.string().optional().describe("Consumption since last reading"),
    },
    (p) => client.addMeterReading(p));

  tool("add_meter_for_rental_object", "Add a utility meter to a rental object.",
    {
      rental_object_id: z.number().int().positive(),
      unique_id: z.string().describe("Unique meter identifier"),
      type: z.string().describe("Meter type"),
      identifier: z.string().optional(),
      unit: z.string().optional(),
    },
    (p) => {
      const { rental_object_id, ...body } = p;
      return client.addMeterForRentalObject(rental_object_id, body);
    });

  tool("add_meter_for_building", "Add a utility meter to a building (common area).",
    {
      building_id: z.number().int().positive(),
      unique_id: z.string().describe("Unique meter identifier"),
      type: z.string().describe("Meter type"),
      identifier: z.string().optional(),
      unit: z.string().optional(),
    },
    (p) => {
      const { building_id, ...body } = p;
      return client.addMeterForBuilding(building_id, body);
    });

  // ── Listings ───────────────────────────────────────────────────────

  tool("list_listings", "List all active property listings.", {},
    () => client.listListings());

  tool("list_listings_by_locale", "List listings with content in a specific language.",
    { locale: z.string().describe("e.g. 'en', 'de', 'et'") },
    (p) => client.listListingsByLocale(p.locale));

  tool("get_listing_availability", "Get availability calendar for a listing.",
    { listing_id: z.number().int().positive() },
    (p) => client.getListingAvailability(p.listing_id));

  tool("list_listing_statuses", "List all possible listing status values.", {},
    () => client.listListingStatuses());

  tool("get_listing_status", "Get the current status of a specific listing.",
    { id: z.number().int().positive() },
    (p) => client.getListingStatus(p.id));

  tool("get_listing_application_settings", "Get the listing application form settings.", {},
    () => client.getListingApplicationSettings());

  tool("get_listing_campaign_prices", "Get campaign/promotional prices for a listing.",
    { listing_id: z.number().int().positive() },
    (p) => client.getListingCampaignPrices(p.listing_id));

  tool("apply_for_listings", "Submit a rental application for one or more listings.",
    {
      listing_id: z.number().int().describe("Listing ID"),
      first_name: z.string(),
      last_name: z.string(),
      email: z.string().email(),
      phone: z.string().optional(),
    },
    (p) => client.applyForListings(p));

  // ── Extra Services ─────────────────────────────────────────────────

  tool("list_extra_services_by_building", "List extra services available for a building.",
    { building_id: z.number().int().positive() },
    (p) => client.listExtraServicesByBuilding(p.building_id));

  tool("list_extra_services_by_rental_agreement", "List extra services ordered for a rental agreement.",
    { uuid: z.string().describe("Rental agreement UUID") },
    (p) => client.listExtraServicesByRentalAgreement(p.uuid));

  // ── Service Requests ───────────────────────────────────────────────

  tool("add_service_request", "Create a new maintenance/service request.",
    {
      title: z.string(),
      description: z.string(),
      status: z.string().describe("e.g. 'open'"),
      priority: z.string().describe("e.g. 'low', 'medium', 'high', 'urgent'"),
      type: z.string(),
      building_id: z.number().int().optional(),
      rental_object_id: z.number().int().optional(),
      tenant_id: z.number().int().optional(),
      deadline: z.string().optional().describe("'YYYY-MM-DD'"),
    },
    (p) => client.addServiceRequest(p));

  // ── Users ──────────────────────────────────────────────────────────

  tool("list_users", "List all users/team members in the Bidrento account.", {},
    () => client.listUsers());
}
