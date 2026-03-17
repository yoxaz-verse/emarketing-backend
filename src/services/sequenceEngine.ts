import nodemailer from 'nodemailer';
import { supabase } from '../supabase';
import { decryptSecret } from '../utils/sendEncryption';

type GraphNode = {
  id: string;
  type: string;
  position?: { x: number; y: number };
  data?: Record<string, any>;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  data?: Record<string, any>;
  label?: string;
};

type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type ValidationError = {
  nodeId?: string;
  message: string;
};

const ALLOWED_NODE_TYPES = new Set([
  'Email',
  'Wait',
  'Condition',
  'AI Agent',
]);

export function validateSequenceGraph(graph: Graph): {
  valid: boolean;
  errors: ValidationError[];
} {
  const errors: ValidationError[] = [];

  if (!graph || !Array.isArray(graph.nodes)) {
    return {
      valid: false,
      errors: [{ message: 'Graph is missing nodes array.' }],
    };
  }

  if (!Array.isArray(graph.edges)) {
    errors.push({ message: 'Graph is missing edges array.' });
  }

  if (graph.nodes.length === 0) {
    errors.push({ message: 'At least one node is required.' });
  }

  for (const node of graph.nodes) {
    if (!ALLOWED_NODE_TYPES.has(node.type)) {
      errors.push({
        nodeId: node.id,
        message: `Unsupported node type: ${node.type}`,
      });
      continue;
    }

    const data = node.data ?? {};

    if (node.type === 'Email') {
      if (!data.subject) {
        errors.push({ nodeId: node.id, message: 'Email subject is required.' });
      }
      if (!data.body && !data.template_id) {
        errors.push({
          nodeId: node.id,
          message: 'Email body or template_id is required.',
        });
      }
    }

    if (node.type === 'Wait') {
      if (!data.delay_amount || !data.delay_unit) {
        errors.push({
          nodeId: node.id,
          message: 'Wait delay amount and unit are required.',
        });
      }
    }

    if (node.type === 'Condition') {
      if (!Array.isArray(data.rules) || data.rules.length === 0) {
        errors.push({
          nodeId: node.id,
          message: 'Condition rules array is required.',
        });
      }
      if (!data.branches || !data.branches.true || !data.branches.false) {
        errors.push({
          nodeId: node.id,
          message: 'Condition branches must include true and false targets.',
        });
      }
    }

    if (node.type === 'AI Agent') {
      if (!data.agent_id) {
        errors.push({ nodeId: node.id, message: 'Agent is required.' });
      }
      if (!data.prompt_template) {
        errors.push({
          nodeId: node.id,
          message: 'Prompt template is required.',
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function getRootNodeIds(graph: Graph): string[] {
  const edges = graph.edges ?? [];
  const targets = new Set(edges.map(edge => edge.target));
  return graph.nodes.filter(node => !targets.has(node.id)).map(n => n.id);
}

function getNextNodeId(graph: Graph, nodeId: string): string | null {
  const edges = graph.edges ?? [];
  const edge = edges.find(e => e.source === nodeId);
  return edge ? edge.target : null;
}

function evaluateRules(rules: any[], context: Record<string, any>): boolean {
  return rules.every(rule => {
    const field = rule?.field;
    const operator = rule?.operator ?? 'equals';
    const value = rule?.value;
    const actual = field ? context?.[field] : undefined;

    switch (operator) {
      case 'equals':
        return actual === value;
      case 'not_equals':
        return actual !== value;
      case 'contains':
        return typeof actual === 'string' && actual.includes(String(value));
      case 'greater_than':
        return Number(actual) > Number(value);
      case 'less_than':
        return Number(actual) < Number(value);
      case 'exists':
        return actual !== undefined && actual !== null;
      case 'not_exists':
        return actual === undefined || actual === null;
      default:
        return false;
    }
  });
}

function delayToMs(amount: number, unit: string): number {
  const safeAmount = Number(amount) || 0;
  switch (unit) {
    case 'minutes':
      return safeAmount * 60 * 1000;
    case 'hours':
      return safeAmount * 60 * 60 * 1000;
    case 'days':
      return safeAmount * 24 * 60 * 60 * 1000;
    default:
      return safeAmount * 1000;
  }
}

async function sendEmail(node: GraphNode, contact: any) {
  const { data: smtp } = await supabase
    .from('smtp_accounts')
    .select('*')
    .eq('is_valid', true)
    .limit(1)
    .single();

  if (!smtp) {
    throw new Error('No valid SMTP account configured.');
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: {
      user: smtp.username,
      pass: decryptSecret(smtp.password),
    },
  });

  const from = node.data?.from || smtp.username;

  const info = await transporter.sendMail({
    from,
    to: contact.email,
    subject: node.data?.subject,
    html: node.data?.body ?? '',
    replyTo: node.data?.reply_to,
  });

  return { message_id: info.messageId, to: contact.email };
}

async function callAgent(node: GraphNode, runContext: any) {
  const { data: agent } = await supabase
    .from('agents')
    .select('*')
    .eq('id', node.data?.agent_id)
    .single();

  if (!agent) {
    throw new Error('Agent not found.');
  }

  const headersConfig =
    typeof agent.headers_config === 'string'
      ? JSON.parse(agent.headers_config)
      : agent.headers_config ?? {};
  const apiKey = process.env.OPENFLOW_API_KEY;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(headersConfig || {}),
  };

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['x-api-key'] = apiKey;
  }

  const payload = {
    agent_id: agent.id,
    node_id: node.id,
    prompt_template: node.data?.prompt_template,
    input_mapping: node.data?.input_mapping ?? {},
    context: runContext,
  };

  if (!agent.endpoint) {
    throw new Error('Agent endpoint is missing.');
  }

  const response = await fetch(agent.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent call failed: ${text}`);
  }

  return response.json();
}

export async function createSequenceRuns(
  sequenceId: string,
  graph: Graph,
  contacts: any[] | null,
  context: Record<string, any>
) {
  const rootNodeIds = getRootNodeIds(graph);
  if (rootNodeIds.length === 0) {
    throw new Error('Sequence has no start node.');
  }

  const rootNodeId = rootNodeIds[0];
  const now = new Date().toISOString();

  const runs: any[] = [];
  const runPayloads = (contacts && contacts.length > 0 ? contacts : [null]).map(
    contact => ({
      sequence_id: sequenceId,
      status: 'running',
      context_json: {
        ...context,
        ...(contact ? { contact } : {}),
      },
      started_at: now,
      updated_at: now,
    })
  );

  const { data: insertedRuns, error } = await supabase
    .from('sequence_runs')
    .insert(runPayloads)
    .select('id');

  if (error || !insertedRuns) {
    throw new Error('Failed to create sequence runs.');
  }

  for (const run of insertedRuns) {
    runs.push(run);
  }

  const stepPayloads = runs.map(run => ({
    run_id: run.id,
    node_id: rootNodeId,
    status: 'scheduled',
    scheduled_for: now,
  }));

  const { error: stepError } = await supabase
    .from('sequence_run_steps')
    .insert(stepPayloads);

  if (stepError) {
    throw new Error('Failed to schedule initial steps.');
  }

  return runs;
}

export async function runSequenceSteps(limit: number = 25) {
  const now = new Date().toISOString();

  const { data: steps } = await supabase
    .from('sequence_run_steps')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_for', now)
    .order('scheduled_for', { ascending: true })
    .limit(limit);

  if (!steps || steps.length === 0) {
    return 0;
  }

  for (const step of steps) {
    const { data: updatedStep } = await supabase
      .from('sequence_run_steps')
      .update({ status: 'running' })
      .eq('id', step.id)
      .eq('status', 'scheduled')
      .select()
      .single();

    if (!updatedStep) {
      continue;
    }

    try {
      const { data: run } = await supabase
        .from('sequence_runs')
        .select('id, sequence_id, status, context_json')
        .eq('id', step.run_id)
        .single();

      if (!run) {
        throw new Error('Run not found.');
      }

      const { data: sequence } = await supabase
        .from('sequences')
        .select('graph_json')
        .eq('id', run.sequence_id)
        .single();

      if (!sequence) {
        throw new Error('Sequence not found.');
      }

      const graph =
        typeof sequence.graph_json === 'string'
          ? (JSON.parse(sequence.graph_json) as Graph)
          : (sequence.graph_json as Graph);
      const node = graph.nodes.find(n => n.id === step.node_id);

      if (!node) {
        throw new Error('Node not found in graph.');
      }

      const runContext = run.context_json ?? {};
      const contact = runContext.contact;
      let output: any = {};
      let nextNodeId: string | null = null;
      let scheduledFor: string | null = null;

      if (node.type === 'Email') {
        if (!contact?.email) {
          throw new Error('Email node requires contact email.');
        }
        output = await sendEmail(node, contact);
        nextNodeId = getNextNodeId(graph, node.id);
        scheduledFor = new Date().toISOString();
      } else if (node.type === 'Wait') {
        const delayMs = delayToMs(
          node.data?.delay_amount,
          node.data?.delay_unit
        );
        nextNodeId = getNextNodeId(graph, node.id);
        scheduledFor = new Date(Date.now() + delayMs).toISOString();
        output = { scheduled_for: scheduledFor };
      } else if (node.type === 'Condition') {
        const rules = node.data?.rules ?? [];
        const passed = evaluateRules(rules, {
          ...runContext,
          ...(contact ?? {}),
        });
        const branch = passed ? 'true' : 'false';
        nextNodeId = node.data?.branches?.[branch] ?? null;
        scheduledFor = new Date().toISOString();
        output = { result: passed, branch };
      } else if (node.type === 'AI Agent') {
        output = await callAgent(node, runContext);
        nextNodeId = getNextNodeId(graph, node.id);
        scheduledFor = new Date().toISOString();
      }

      await supabase
        .from('sequence_run_steps')
        .update({
          status: 'completed',
          output_json: output,
          completed_at: new Date().toISOString(),
        })
        .eq('id', step.id);

      await supabase
        .from('sequence_runs')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', step.run_id);

      if (nextNodeId) {
        await supabase.from('sequence_run_steps').insert({
          run_id: step.run_id,
          node_id: nextNodeId,
          status: 'scheduled',
          scheduled_for: scheduledFor ?? new Date().toISOString(),
        });
      } else {
        await supabase
          .from('sequence_runs')
          .update({ status: 'completed', updated_at: new Date().toISOString() })
          .eq('id', step.run_id);
      }
    } catch (err: any) {
      await supabase
        .from('sequence_run_steps')
        .update({
          status: 'failed',
          error: err?.message ?? 'Step failed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', step.id);

      await supabase
        .from('sequence_runs')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', step.run_id);
    }
  }

  return steps.length;
}
