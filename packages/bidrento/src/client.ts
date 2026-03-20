/**
 * Bidrento API Client
 *
 * Uses native fetch (no axios). POST bodies are application/x-www-form-urlencoded.
 * Auth via X-API-TOKEN header.
 */

import { createLogger, type Logger } from "@mcp-stack/core";

// ─── Config ──────────────────────────────────────────────────────────

export interface BidrentoClientConfig {
  baseUrl: string;   // https://pro.bidrento.com
  apiKey: string;    // X-API-TOKEN value
  logger?: Logger;
}

// ─── Client ──────────────────────────────────────────────────────────

export class BidrentoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly log: Logger;

  constructor(config: BidrentoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.log = config.logger ?? createLogger("bidrento-client");
  }

  // ── HTTP Helpers ───────────────────────────────────────────────────

  private async get<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      headers: { "X-API-TOKEN": this.apiKey, Accept: "application/json" },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Bidrento returns 404 for empty invoice lists — treat as empty
      if (res.status === 404 && path.includes("invoice")) {
        return [] as unknown as T;
      }
      throw new Error(`Bidrento API error (${res.status} ${path}): ${body.slice(0, 200)}`);
    }

    return res.json() as Promise<T>;
  }

  private async postForm<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    const clean = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined && v !== null),
    );
    const formBody = new URLSearchParams(
      Object.entries(clean).map(([k, v]) => [k, String(v)]),
    );

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "X-API-TOKEN": this.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formBody.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Bidrento API error (${res.status} POST ${path}): ${text.slice(0, 200)}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Buildings ──────────────────────────────────────────────────────

  async listBuildings() { return this.get("/api/rest/public/building"); }

  // ── Rental Objects ─────────────────────────────────────────────────

  async listRentalObjects() { return this.get("/api/rest/public/rentalObject"); }
  async listRentalObjectsByBuilding(buildingId: number) { return this.get(`/api/rest/public/rentalObjectListByBuilding/${buildingId}`); }
  async checkObjectsAvailable(ids?: string) { return this.get("/api/rest/public/objectAvailable", ids ? { ids } : undefined); }
  async checkObjectsAvailableForBuilding(buildingId: number) { return this.get(`/api/rest/public/objectAvailableForBuilding/${buildingId}`); }
  async reportEventForRentalObject(rentalObjectId: number) { return this.postForm(`/api/rest/public/rentalObject/${rentalObjectId}/reportEvent`, {}); }

  // ── Tenants ────────────────────────────────────────────────────────

  async listTenants() { return this.get("/api/rest/public/tenant"); }
  async checkTenantEmail(email: string) { return this.get("/api/rest/public/checkTenantEmail", { email }); }
  async checkEmail(email: string) { return this.get("/api/rest/public/check-email", { email }); }
  async addTenant(body: Record<string, unknown>) { return this.postForm("/api/rest/public/addTenant", body); }

  // ── Rental Agreements ──────────────────────────────────────────────

  async listRentalAgreements(params?: Record<string, unknown>) { return this.get("/api/rest/public/rentalAgreement", params); }
  async getRentalAgreement(uuid: string) { return this.get(`/api/rest/public/rentalAgreement/${uuid}`); }
  async listRentalAgreementsByObject(id: number, params?: Record<string, unknown>) { return this.get(`/api/rest/public/rentalAgreement/${id}`, params); }
  async updateRentalAgreement(uuid: string, body: Record<string, unknown>) { return this.postForm(`/api/rest/public/rentalAgreement/${uuid}`, body); }
  async addRentalAgreement(body: Record<string, unknown>) { return this.postForm("/api/rest/public/addRentalAgreement", body); }
  async terminateRentalAgreement(body: Record<string, unknown>) { return this.postForm("/api/rest/public/terminateRentalAgreement", body); }

  // ── Price Changes ──────────────────────────────────────────────────

  async getRentalAgreementPriceChanges(uuid: string) { return this.get(`/api/rest/public/getRentalAgreementPriceChange/${uuid}`); }
  async addRentalAgreementPriceChange(uuid: string, body: Record<string, unknown>) { return this.postForm(`/api/rest/public/addRentalAgreementPriceChange/${uuid}`, body); }
  async updateRentalAgreementPriceChange(id: number, body: Record<string, unknown>) { return this.postForm(`/api/rest/public/updateRentalAgreementPriceChange/${id}`, body); }

  // ── Invoices ───────────────────────────────────────────────────────

  async listInvoices(rentalAgreementUuid?: string) { return this.get("/api/rest/public/invoices", rentalAgreementUuid ? { rental_agreement_uuid: rentalAgreementUuid } : undefined); }
  async createInvoice(body: Record<string, unknown>) { return this.postForm("/api/rest/public/invoice", body); }

  // ── Meters ─────────────────────────────────────────────────────────

  async listMeters() { return this.get("/api/rest/public/meter"); }
  async listMetersByRentalObject(id: number) { return this.get(`/api/rest/public/meter/${id}`); }
  async listMeterTypes() { return this.get("/api/rest/public/meterTypes"); }
  async listMeterUnitTypes() { return this.get("/api/rest/public/meterUnitTypes"); }
  async addMeterReading(body: Record<string, unknown>) { return this.postForm("/api/rest/public/meterReading", body); }
  async addMeterForRentalObject(id: number, body: Record<string, unknown>) { return this.postForm(`/api/rest/public/addMeterForRentalObject/${id}`, body); }
  async addMeterForBuilding(id: number, body: Record<string, unknown>) { return this.postForm(`/api/rest/public/addMeterForBuilding/${id}`, body); }

  // ── Listings ───────────────────────────────────────────────────────

  async listListings(params?: Record<string, unknown>) { return this.get("/api/rest/public/listing", params); }
  async listListingsByLocale(locale: string, params?: Record<string, unknown>) { return this.get(`/api/rest/public/listing/${locale}`, params); }
  async getListingAvailability(id: number) { return this.get(`/api/rest/public/availabilityListing/${id}`); }
  async listListingStatuses() { return this.get("/api/rest/public/listingStatus"); }
  async getListingStatus(id: number) { return this.get(`/api/rest/public/listingStatus/${id}`); }
  async getListingApplicationSettings() { return this.get("/api/rest/public/listingApplicationSettings"); }
  async getListingCampaignPrices(id: number) { return this.get(`/api/rest/public/listingCampaignPrices/${id}`); }
  async applyForListings(body: Record<string, unknown>) { return this.postForm("/api/rest/public/applyListings", body); }

  // ── Extra Services ─────────────────────────────────────────────────

  async listExtraServicesByBuilding(id: number) { return this.get(`/api/rest/public/extraServiceListByBuilding/${id}`); }
  async listExtraServicesByRentalAgreement(uuid: string) { return this.get(`/api/rest/public/extraServiceListByRentalAgreement/${uuid}`); }

  // ── Service Requests ───────────────────────────────────────────────

  async addServiceRequest(body: Record<string, unknown>) { return this.postForm("/api/rest/public/addServiceRequest", body); }

  // ── Users ──────────────────────────────────────────────────────────

  async listUsers() { return this.get("/api/rest/public/user"); }
}
