import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";

describe("AppModule bootstrap", () => {
  it("compiles without dependency resolution errors", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
