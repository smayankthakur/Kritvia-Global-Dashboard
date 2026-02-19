import { MODULE_METADATA } from "@nestjs/common/constants";
import { ActivityLogModule } from "../src/activity-log/activity-log.module";
import { GraphModule } from "../src/graph/graph.module";

describe("GraphModule bootstrap", () => {
  it("imports ActivityLogModule so AutoNudgeService dependencies resolve", () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, GraphModule) as unknown[] | undefined;
    expect(imports).toBeDefined();
    expect(imports).toContain(ActivityLogModule);
  });
});
