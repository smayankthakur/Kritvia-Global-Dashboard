-- Phase 8.4.4.4: API token security logging entity type

ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'API_TOKEN';
