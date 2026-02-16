export interface RevenueVelocityResponseDto {
  avgCloseDays: number;
  stageConversion: {
    leadToDealPct: number;
    dealToWonPct: number;
  };
  pipelineAging: {
    "0_7": number;
    "8_14": number;
    "15_30": number;
    "30_plus": number;
  };
  dropOffPct: number;
  counts: {
    leads: number;
    deals: number;
    won: number;
    lost: number;
    open: number;
  };
}

