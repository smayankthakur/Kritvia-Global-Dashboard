import { Module } from "@nestjs/common";
import { PolicyResolverService } from "./policy-resolver.service";

@Module({
  providers: [PolicyResolverService],
  exports: [PolicyResolverService]
})
export class PolicyModule {}
