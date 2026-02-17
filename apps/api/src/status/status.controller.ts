import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { StatusService } from "./status.service";

@Controller("status")
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Get()
  async getStatus() {
    return this.statusService.getPublicStatus();
  }

  @Get("incidents")
  async listIncidents() {
    return this.statusService.listPublicIncidents();
  }

  @Get("incidents/:slug")
  async getIncident(@Param("slug") slug: string) {
    const incident = await this.statusService.getPublicIncidentBySlug(slug);
    if (!incident) {
      throw new NotFoundException("Public incident not found");
    }
    return incident;
  }
}
