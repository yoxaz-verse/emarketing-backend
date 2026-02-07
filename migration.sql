-- Phase 4: Voice Agents Database Changes

-- 1) CREATE TABLE: voice_agents
CREATE TABLE IF NOT EXISTS voice_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'retired')),
    languages TEXT[] DEFAULT '{}',
    persona_type TEXT,
    assigned_number TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2) CREATE TABLE: campaign_voice_agents
CREATE TABLE IF NOT EXISTS campaign_voice_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id),
    voice_agent_id UUID NOT NULL REFERENCES voice_agents(id),
    active BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3) ALTER TABLE: voice_calls
-- Adding voice_agent_id (nullable, FK → voice_agents.id)
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS voice_agent_id UUID REFERENCES voice_agents(id);
