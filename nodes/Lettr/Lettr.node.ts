import type {
  IDataObject,
  IExecuteFunctions,
  IHttpRequestMethods,
  IHttpRequestOptions,
  INodeExecutionData,
  INodeProperties,
  INodeType,
  INodeTypeDescription,
  JsonObject,
} from "n8n-workflow";
import { NodeApiError, NodeOperationError } from "n8n-workflow";

const LETTR_BASE_URL = "https://app.lettr.com/api";

/**
 * Node version reported to the API. Hardcoded as a build-time constant because
 * n8n Cloud forbids community nodes from accessing `fs`/`path`/`__dirname` at
 * runtime. Keep this in sync with the `version` field in package.json.
 */
const LETTR_VERSION = "0.6.0";

function splitRecipientList(value: string): string[] {
  return value
    .split(/[,\n;]/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseOptionalJson(
  value: string,
  fieldName: string,
  itemIndex: number,
  context: IExecuteFunctions,
): IDataObject | IDataObject[] {
  try {
    return JSON.parse(value) as IDataObject | IDataObject[];
  } catch {
    throw new NodeOperationError(
      context.getNode(),
      `"${fieldName}" must be valid JSON when provided.`,
      { itemIndex },
    );
  }
}

function collectProperties(ui: IDataObject): IDataObject {
  const rows = (ui.property as IDataObject[] | undefined) ?? [];
  const result: IDataObject = {};
  for (const row of rows) {
    const name = ((row.name as string) ?? "").trim();
    if (name) result[name] = row.value ?? "";
  }
  return result;
}

function getResponseData(response: IDataObject): IDataObject {
  return (response.data as IDataObject) ?? {};
}

function getResponseList(response: IDataObject, key: string): IDataObject[] {
  const data = getResponseData(response);
  const values = data[key];
  return Array.isArray(values) ? (values as IDataObject[]) : [];
}

function getPagination(response: IDataObject): IDataObject {
  const data = getResponseData(response);
  return (data.pagination as IDataObject) ?? {};
}

async function lettrApiRequest(
  this: IExecuteFunctions,
  method: IHttpRequestMethods,
  endpoint: string,
  itemIndex: number,
  body: IDataObject = {},
  qs: IDataObject = {},
  extraHeaders: IDataObject = {},
): Promise<IDataObject> {
  const options: IHttpRequestOptions = {
    method,
    baseURL: LETTR_BASE_URL,
    url: endpoint,
    json: true,
    body,
    qs,
    headers: {
      "User-Agent": `lettr-n8n/${LETTR_VERSION}`,
      ...extraHeaders,
    },
  };

  if (Object.keys(body).length === 0) {
    delete options.body;
  }

  if (Object.keys(qs).length === 0) {
    delete options.qs;
  }

  try {
    return (await this.helpers.httpRequestWithAuthentication.call(
      this,
      "lettrApi",
      options,
    )) as IDataObject;
  } catch (error) {
    const err = error as {
      response?: { body?: unknown; data?: unknown };
      message?: string;
    };
    const body = err?.response?.body ?? err?.response?.data;
    let detail = "";

    if (body && typeof body === "object") {
      const b = body as IDataObject;
      const apiMessage = (b.message ?? b.error ?? "") as string;
      const errors = b.errors as IDataObject | undefined;
      const fieldErrors =
        errors && typeof errors === "object"
          ? Object.entries(errors)
              .map(([field, msgs]) => {
                const list = Array.isArray(msgs)
                  ? (msgs as string[]).join("; ")
                  : String(msgs);
                return `${field}: ${list}`;
              })
              .join(" | ")
          : "";
      detail = [apiMessage, fieldErrors].filter(Boolean).join(" — ");
    } else if (typeof body === "string") {
      detail = body;
    }

    throw new NodeApiError(this.getNode(), error as JsonObject, {
      itemIndex,
      message: detail || err?.message || "Lettr API request failed",
    });
  }
}

async function paginatedGetMany(
  this: IExecuteFunctions,
  endpoint: string,
  dataKey: string,
  itemIndex: number,
  queryBase: IDataObject,
  returnAll: boolean,
  limit: number,
  simplify: boolean,
  startingPage: number,
): Promise<INodeExecutionData[]> {
  const out: INodeExecutionData[] = [];

  if (!returnAll) {
    const qs: IDataObject = {
      ...queryBase,
      per_page: limit,
      page: startingPage,
    };
    const response = await lettrApiRequest.call(
      this,
      "GET",
      endpoint,
      itemIndex,
      {},
      qs,
    );

    if (!simplify) {
      out.push({ json: response, pairedItem: itemIndex });
    } else {
      for (const entry of getResponseList(response, dataKey)) {
        out.push({ json: entry, pairedItem: itemIndex });
      }
    }
    return out;
  }

  const entries: IDataObject[] = [];
  let page = Math.max(1, startingPage);
  let hasMore = true;

  while (hasMore) {
    const qs: IDataObject = { ...queryBase, per_page: 100, page };
    const response = await lettrApiRequest.call(
      this,
      "GET",
      endpoint,
      itemIndex,
      {},
      qs,
    );
    entries.push(...getResponseList(response, dataKey));
    const pagination = getPagination(response);
    const currentPage = Number(pagination.current_page ?? page);
    const lastPage = Number(pagination.last_page ?? currentPage);
    hasMore = currentPage < lastPage;
    page = currentPage + 1;
  }

  if (!simplify) {
    out.push({ json: { data: { [dataKey]: entries } }, pairedItem: itemIndex });
  } else {
    for (const entry of entries) {
      out.push({ json: entry, pairedItem: itemIndex });
    }
  }
  return out;
}

async function cursorGetMany(
  this: IExecuteFunctions,
  endpoint: string,
  itemIndex: number,
  queryBase: IDataObject,
  pageSizeParam: string,
  returnAll: boolean,
  limit: number,
  simplify: boolean,
  extract: (response: IDataObject) => {
    list: IDataObject[];
    nextCursor?: string;
  },
  rebuild: (entries: IDataObject[]) => IDataObject,
): Promise<INodeExecutionData[]> {
  const out: INodeExecutionData[] = [];

  if (!returnAll) {
    const qs: IDataObject = { ...queryBase, [pageSizeParam]: limit };
    const response = await lettrApiRequest.call(
      this,
      "GET",
      endpoint,
      itemIndex,
      {},
      qs,
    );

    if (!simplify) {
      out.push({ json: response, pairedItem: itemIndex });
    } else {
      for (const entry of extract(response).list) {
        out.push({ json: entry, pairedItem: itemIndex });
      }
    }
    return out;
  }

  const entries: IDataObject[] = [];
  let cursor: string | undefined;

  do {
    const qs: IDataObject = { ...queryBase, [pageSizeParam]: 100 };
    if (cursor) qs.cursor = cursor;

    const response = await lettrApiRequest.call(
      this,
      "GET",
      endpoint,
      itemIndex,
      {},
      qs,
    );

    const { list, nextCursor } = extract(response);
    entries.push(...list);
    cursor = nextCursor;
  } while (cursor);

  if (!simplify) {
    out.push({ json: rebuild(entries), pairedItem: itemIndex });
  } else {
    for (const entry of entries) {
      out.push({ json: entry, pairedItem: itemIndex });
    }
  }
  return out;
}

const webhookEventOptions = [
  { name: "Engagement: AMP Click", value: "engagement.amp_click" },
  {
    name: "Engagement: AMP Initial Open",
    value: "engagement.amp_initial_open",
  },
  { name: "Engagement: AMP Open", value: "engagement.amp_open" },
  { name: "Engagement: Click", value: "engagement.click" },
  { name: "Engagement: Initial Open", value: "engagement.initial_open" },
  { name: "Engagement: Open", value: "engagement.open" },
  { name: "Generation: Failure", value: "generation.generation_failure" },
  { name: "Generation: Rejection", value: "generation.generation_rejection" },
  { name: "Message: Bounce", value: "message.bounce" },
  { name: "Message: Delay", value: "message.delay" },
  { name: "Message: Delivery", value: "message.delivery" },
  { name: "Message: Injection", value: "message.injection" },
  { name: "Message: Out of Band", value: "message.out_of_band" },
  { name: "Message: Policy Rejection", value: "message.policy_rejection" },
  { name: "Message: Spam Complaint", value: "message.spam_complaint" },
  { name: "Relay: Delivery", value: "relay.relay_delivery" },
  { name: "Relay: Injection", value: "relay.relay_injection" },
  { name: "Relay: Permanent Failure", value: "relay.relay_permfail" },
  { name: "Relay: Rejection", value: "relay.relay_rejection" },
  { name: "Relay: Temporary Failure", value: "relay.relay_tempfail" },
  { name: "Unsubscribe: Link", value: "unsubscribe.link_unsubscribe" },
  { name: "Unsubscribe: List", value: "unsubscribe.list_unsubscribe" },
];

const listOperationProperties: INodeProperties[] = [
  {
    displayName: "Return All",
    name: "returnAll",
    type: "boolean",
    default: false,
    description: "Whether to return all results",
  },
  {
    displayName: "Limit",
    name: "limit",
    type: "number",
    typeOptions: {
      minValue: 1,
      maxValue: 250,
    },
    default: 50,
    description: "Max number of results to return",
    displayOptions: {
      show: {
        returnAll: [false],
      },
    },
  },
  {
    displayName: "Simplify",
    name: "simplify",
    type: "boolean",
    default: true,
    description: "Whether to split array results into separate output items",
  },
];

export class Lettr implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Lettr",
    name: "lettr",
    icon: "file:lettr.svg",
    group: ["output"],
    version: 1,
    usableAsTool: true,
    documentationUrl: "https://docs.lettr.com/api-reference/introduction",
    subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
    description: "Interact with Lettr transactional email APIs",
    defaults: {
      name: "Lettr",
    },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [
      {
        name: "lettrApi",
        required: true,
      },
    ],
    properties: [
      {
        displayName: "Resource",
        name: "resource",
        type: "options",
        noDataExpression: true,
        default: "email",
        options: [
          {
            name: "Email",
            value: "email",
          },
          {
            name: "Domain",
            value: "domain",
          },
          {
            name: "Folder",
            value: "folder",
          },
          {
            name: "Project",
            value: "project",
          },
          {
            name: "Template",
            value: "template",
          },
          {
            name: "Webhook",
            value: "webhook",
          },
          {
            name: "Campaign",
            value: "campaign",
          },
          {
            name: "Audience Contact",
            value: "audienceContact",
          },
          {
            name: "Audience List",
            value: "audienceList",
          },
          {
            name: "Audience Property",
            value: "audienceProperty",
          },
          {
            name: "Audience Segment",
            value: "audienceSegment",
          },
          {
            name: "Audience Topic",
            value: "audienceTopic",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "send",
        displayOptions: {
          show: {
            resource: ["email"],
          },
        },
        options: [
          {
            name: "Cancel Scheduled",
            value: "cancelScheduled",
            description: "Cancel a scheduled email transmission",
            action: "Cancel a scheduled email",
          },
          {
            name: "Get",
            value: "get",
            description: "Get an email request by ID",
            action: "Get an email request",
          },
          {
            name: "Get Events",
            value: "getEvents",
            description:
              "List email events (delivery, bounce, open, click, etc.)",
            action: "Get email events",
          },
          {
            name: "Get Scheduled",
            value: "getScheduled",
            description: "Get a scheduled email transmission by ID",
            action: "Get a scheduled email",
          },
          {
            name: "Schedule",
            value: "schedule",
            description: "Schedule a transactional email for future delivery",
            action: "Schedule a transactional email",
          },
          {
            name: "Send",
            value: "send",
            description: "Send a transactional email",
            action: "Send a transactional email",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "getAll",
        displayOptions: {
          show: {
            resource: ["domain"],
          },
        },
        options: [
          {
            name: "Create",
            value: "create",
            description: "Register a new sending domain",
            action: "Create a domain",
          },
          {
            name: "Delete",
            value: "delete",
            description: "Delete a sending domain",
            action: "Delete a domain",
          },
          {
            name: "Get",
            value: "get",
            description: "Get a sending domain by name",
            action: "Get a domain",
          },
          {
            name: "Get Many",
            value: "getAll",
            description: "Get all sending domains",
            action: "Get many domains",
          },
          {
            name: "Verify",
            value: "verify",
            description: "Verify a domain's DNS records",
            action: "Verify a domain",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "getAll",
        displayOptions: {
          show: {
            resource: ["template"],
          },
        },
        options: [
          {
            name: "Create",
            value: "create",
            description: "Create a new email template",
            action: "Create a template",
          },
          {
            name: "Delete",
            value: "delete",
            description: "Delete a template",
            action: "Delete a template",
          },
          {
            name: "Get",
            value: "get",
            description: "Get a template by slug",
            action: "Get a template",
          },
          {
            name: "Get HTML",
            value: "getHtml",
            description: "Get a template's active HTML and merge tags",
            action: "Get template HTML",
          },
          {
            name: "Get Many",
            value: "getAll",
            description: "Get all templates",
            action: "Get many templates",
          },
          {
            name: "Get Merge Tags",
            value: "getMergeTags",
            description: "Get the merge tags for a template version",
            action: "Get template merge tags",
          },
          {
            name: "Update",
            value: "update",
            description: "Update a template's name or content",
            action: "Update a template",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "getAll",
        displayOptions: {
          show: {
            resource: ["webhook"],
          },
        },
        options: [
          {
            name: "Create",
            value: "create",
            description: "Create a new webhook",
            action: "Create a webhook",
          },
          {
            name: "Delete",
            value: "delete",
            description: "Delete a webhook",
            action: "Delete a webhook",
          },
          {
            name: "Get",
            value: "get",
            description: "Get a webhook by ID",
            action: "Get a webhook",
          },
          {
            name: "Get Many",
            value: "getAll",
            description: "Get all webhooks",
            action: "Get many webhooks",
          },
          {
            name: "Update",
            value: "update",
            description: "Update an existing webhook",
            action: "Update a webhook",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "contactGetAll",
        displayOptions: {
          show: {
            resource: ["audienceContact"],
          },
        },
        options: [
          {
            name: "Attach to List",
            value: "contactAttachList",
            description: "Attach a contact to a list",
            action: "Attach a contact to a list",
          },
          {
            name: "Bulk Attach to Lists",
            value: "contactBulkAttachLists",
            description: "Attach many contacts to many lists",
            action: "Bulk attach contacts to lists",
          },
          {
            name: "Bulk Detach From Lists",
            value: "contactBulkDetachLists",
            description: "Detach many contacts from many lists",
            action: "Bulk detach contacts from lists",
          },
          {
            name: "Bulk Subscribe to Topics",
            value: "contactBulkSubscribeTopics",
            description: "Subscribe many contacts to many topics",
            action: "Bulk subscribe contacts to topics",
          },
          {
            name: "Bulk Unsubscribe From Topics",
            value: "contactBulkUnsubscribeTopics",
            description: "Unsubscribe many contacts from many topics",
            action: "Bulk unsubscribe contacts from topics",
          },
          {
            name: "Create",
            value: "contactCreate",
            description: "Create a contact",
            action: "Create an audience contact",
          },
          {
            name: "Create Many",
            value: "contactCreateMany",
            description: "Create many contacts at once",
            action: "Create many audience contacts",
          },
          {
            name: "Delete",
            value: "contactDelete",
            description: "Delete a contact",
            action: "Delete an audience contact",
          },
          {
            name: "Detach From List",
            value: "contactDetachList",
            description: "Detach a contact from a list",
            action: "Detach a contact from a list",
          },
          {
            name: "Get",
            value: "contactGet",
            description: "Get a contact by ID",
            action: "Get an audience contact",
          },
          {
            name: "Get Many",
            value: "contactGetAll",
            description: "Get many contacts",
            action: "Get many audience contacts",
          },
          {
            name: "Subscribe to Topic",
            value: "contactSubscribeTopic",
            description: "Subscribe a contact to a topic",
            action: "Subscribe a contact to a topic",
          },
          {
            name: "Unsubscribe From Topic",
            value: "contactUnsubscribeTopic",
            description: "Unsubscribe a contact from a topic",
            action: "Unsubscribe a contact from a topic",
          },
          {
            name: "Update",
            value: "contactUpdate",
            description: "Update a contact",
            action: "Update an audience contact",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "listGetAll",
        displayOptions: {
          show: {
            resource: ["audienceList"],
          },
        },
        options: [
          {
            name: "Create",
            value: "listCreate",
            description: "Create an audience list",
            action: "Create an audience list",
          },
          {
            name: "Delete",
            value: "listDelete",
            description: "Delete an audience list",
            action: "Delete an audience list",
          },
          {
            name: "Delete Many",
            value: "listDeleteMany",
            description: "Delete many audience lists",
            action: "Delete many audience lists",
          },
          {
            name: "Get",
            value: "listGet",
            description: "Get an audience list by ID",
            action: "Get an audience list",
          },
          {
            name: "Get Many",
            value: "listGetAll",
            description: "Get many audience lists",
            action: "Get many audience lists",
          },
          {
            name: "Update",
            value: "listUpdate",
            description: "Update an audience list",
            action: "Update an audience list",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "propertyGetAll",
        displayOptions: {
          show: {
            resource: ["audienceProperty"],
          },
        },
        options: [
          {
            name: "Create",
            value: "propertyCreate",
            description: "Create a property",
            action: "Create an audience property",
          },
          {
            name: "Delete",
            value: "propertyDelete",
            description: "Delete a property",
            action: "Delete an audience property",
          },
          {
            name: "Get",
            value: "propertyGet",
            description: "Get a property by ID",
            action: "Get an audience property",
          },
          {
            name: "Get Many",
            value: "propertyGetAll",
            description: "Get many properties",
            action: "Get many audience properties",
          },
          {
            name: "Update",
            value: "propertyUpdate",
            description: "Update a property",
            action: "Update an audience property",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "segmentGetAll",
        displayOptions: {
          show: {
            resource: ["audienceSegment"],
          },
        },
        options: [
          {
            name: "Create",
            value: "segmentCreate",
            description: "Create a segment",
            action: "Create an audience segment",
          },
          {
            name: "Delete",
            value: "segmentDelete",
            description: "Delete a segment",
            action: "Delete an audience segment",
          },
          {
            name: "Get",
            value: "segmentGet",
            description: "Get a segment by ID",
            action: "Get an audience segment",
          },
          {
            name: "Get Many",
            value: "segmentGetAll",
            description: "Get many segments",
            action: "Get many audience segments",
          },
          {
            name: "Update",
            value: "segmentUpdate",
            description: "Update a segment",
            action: "Update an audience segment",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "topicGetAll",
        displayOptions: {
          show: {
            resource: ["audienceTopic"],
          },
        },
        options: [
          {
            name: "Create",
            value: "topicCreate",
            description: "Create a topic",
            action: "Create an audience topic",
          },
          {
            name: "Delete",
            value: "topicDelete",
            description: "Delete a topic",
            action: "Delete an audience topic",
          },
          {
            name: "Get",
            value: "topicGet",
            description: "Get a topic by ID",
            action: "Get an audience topic",
          },
          {
            name: "Get Many",
            value: "topicGetAll",
            description: "Get many topics",
            action: "Get many audience topics",
          },
          {
            name: "Update",
            value: "topicUpdate",
            description: "Update a topic",
            action: "Update an audience topic",
          },
        ],
      },
      {
        displayName: "Request ID",
        name: "requestId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["get"],
          },
        },
        description: "ID of the email request to retrieve",
      },
      {
        displayName: "From Email",
        name: "from",
        type: "string",
        required: true,
        default: "",
        placeholder: "support@example.com",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["send", "schedule"],
          },
        },
        description: "Sender email address",
      },
      {
        displayName: "To",
        name: "to",
        type: "string",
        required: true,
        default: "",
        placeholder: "alice@example.com, bob@example.com",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["send", "schedule"],
          },
        },
        description:
          "Recipient email addresses (comma, semicolon, or newline separated)",
      },
      {
        displayName: "Subject",
        name: "subject",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["send", "schedule"],
          },
        },
        description:
          "Email subject line. Required unless using a template — when omitted with a template, the template's subject is used",
      },
      {
        displayName: "HTML",
        name: "html",
        type: "string",
        typeOptions: {
          rows: 4,
        },
        default: "",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["send", "schedule"],
          },
        },
        description: "HTML body for the email",
      },
      {
        displayName: "Text",
        name: "text",
        type: "string",
        typeOptions: {
          rows: 4,
        },
        default: "",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["send", "schedule"],
          },
        },
        description: "Plain-text body for the email",
      },
      {
        displayName: "Template Slug",
        name: "templateSlug",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["send", "schedule"],
          },
        },
        description: "Template slug to render instead of raw HTML/Text",
      },
      {
        displayName: "Additional Fields",
        name: "additionalFields",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["send", "schedule"],
          },
        },
        options: [
          {
            displayName: "Amp HTML",
            name: "ampHtml",
            type: "string",
            default: "",
            description: "AMP HTML body",
          },
          {
            displayName: "Idempotency Key",
            name: "idempotencyKey",
            type: "string",
            default: "",
            description:
              "Opaque key making this send safe to retry. Reuse the same value on a retry and the API returns the original result instead of delivering a second email. Derive it from what the send is about - an order ID, an invoice number - rather than from a timestamp or a random value, which defeat the point on a retry. Keys are kept 24 hours and scoped per team and API key. Applies to Send only.",
          },
          {
            displayName: "BCC",
            name: "bcc",
            type: "string",
            default: "",
            description:
              "BCC recipient emails (comma, semicolon, or newline separated)",
          },
          {
            displayName: "Campaign ID",
            name: "campaignId",
            type: "number",
            default: 0,
            description: "Optional campaign identifier",
          },
          {
            displayName: "CC",
            name: "cc",
            type: "string",
            default: "",
            description:
              "CC recipient emails (comma, semicolon, or newline separated)",
          },
          {
            displayName: "From Name",
            name: "fromName",
            type: "string",
            default: "",
            description: "Display name for the sender",
          },
          {
            displayName: "Metadata (JSON)",
            name: "metadataJson",
            type: "string",
            typeOptions: {
              rows: 4,
            },
            default: "",
            placeholder: '{"orderId":"12345"}',
            description: "Metadata object as JSON",
          },
          {
            displayName: "Options (JSON)",
            name: "optionsJson",
            type: "string",
            typeOptions: {
              rows: 4,
            },
            default: "",
            placeholder: '{"track_clicks":true}',
            description: "Provider options object as JSON",
          },
          {
            displayName: "Project ID",
            name: "projectId",
            type: "number",
            default: 0,
            description: "Project ID used for routing and analytics",
          },
          {
            displayName: "Reply-To",
            name: "replyTo",
            type: "string",
            default: "",
            description: "Reply-to email address",
          },
          {
            displayName: "Reply-To Name",
            name: "replyToName",
            type: "string",
            default: "",
            description: "Reply-to display name",
          },
          {
            displayName: "Substitution Data (JSON)",
            name: "substitutionDataJson",
            type: "string",
            typeOptions: {
              rows: 4,
            },
            default: "",
            placeholder: '{"first_name":"Alice"}',
            description: "Template substitution object as JSON",
          },
          {
            displayName: "Template Version",
            name: "templateVersion",
            type: "number",
            default: 0,
            description: "Template version ID",
          },
          {
            displayName: "Attachments (JSON)",
            name: "attachmentsJson",
            type: "string",
            typeOptions: {
              rows: 4,
            },
            default: "",
            placeholder:
              '[{"name":"invoice.pdf","type":"application/pdf","data":"<base64>"}]',
            description: "Array of attachment objects as JSON",
          },
        ],
      },
      {
        displayName: "Scheduled At",
        name: "scheduledAt",
        type: "dateTime",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["schedule"],
          },
        },
        description:
          "When to send the email (UTC). Must be at least 5 minutes in the future and within 3 days",
      },
      {
        displayName: "Transmission ID",
        name: "transmissionId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getScheduled", "cancelScheduled"],
          },
        },
        description: "ID returned when the email was scheduled",
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getEvents"],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getEvents"],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getEvents"],
          },
        },
      },
      {
        displayName: "Event Types",
        name: "eventTypes",
        type: "multiOptions",
        default: [],
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getEvents"],
          },
        },
        options: [
          { name: "AMP Click", value: "amp_click" },
          { name: "AMP Initial Open", value: "amp_initial_open" },
          { name: "AMP Open", value: "amp_open" },
          { name: "Bounce", value: "bounce" },
          { name: "Click", value: "click" },
          { name: "Delay", value: "delay" },
          { name: "Delivery", value: "delivery" },
          { name: "Generation Failure", value: "generation_failure" },
          { name: "Generation Rejection", value: "generation_rejection" },
          { name: "Initial Open", value: "initial_open" },
          { name: "Injection", value: "injection" },
          { name: "Link Unsubscribe", value: "link_unsubscribe" },
          { name: "List Unsubscribe", value: "list_unsubscribe" },
          { name: "Open", value: "open" },
          { name: "Out of Band", value: "out_of_band" },
          { name: "Policy Rejection", value: "policy_rejection" },
          { name: "Spam Complaint", value: "spam_complaint" },
        ],
        description:
          "Filter to specific event types. Leave empty to include all",
      },
      {
        displayName: "Event Filters",
        name: "eventFilters",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getEvents"],
          },
        },
        options: [
          {
            displayName: "Bounce Classes",
            name: "bounceClasses",
            type: "string",
            default: "",
            description: "Comma-separated bounce classification codes",
          },
          {
            displayName: "From Date",
            name: "fromDate",
            type: "string",
            default: "",
            placeholder: "2025-01-01",
            description: "Lower date bound. Defaults to 10 days ago",
          },
          {
            displayName: "Recipients",
            name: "recipients",
            type: "string",
            default: "",
            description:
              "Comma-separated recipient email addresses to filter by",
          },
          {
            displayName: "To Date",
            name: "toDate",
            type: "string",
            default: "",
            placeholder: "2025-01-31",
            description: "Upper date bound. Defaults to now",
          },
          {
            displayName: "Transmission ID",
            name: "transmissionId",
            type: "string",
            default: "",
            description: "Filter events to a single transmission (request_id)",
          },
        ],
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getAll"],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getAll"],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getAll"],
          },
        },
      },
      {
        displayName: "Recipients Filter",
        name: "recipients",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getAll"],
          },
        },
        description:
          "Only return requests where one of these recipients appears",
      },
      {
        displayName: "From Date",
        name: "fromDate",
        type: "string",
        default: "",
        placeholder: "2025-01-01",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getAll"],
          },
        },
        description: "Lower date bound (YYYY-MM-DD)",
      },
      {
        displayName: "To Date",
        name: "toDate",
        type: "string",
        default: "",
        placeholder: "2025-01-31",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getAll"],
          },
        },
        description: "Upper date bound (YYYY-MM-DD)",
      },
      {
        displayName: "Cursor",
        name: "cursor",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: ["email"],
            operation: ["getAll"],
          },
        },
        description: "Cursor token for pagination",
      },
      {
        displayName: "Domain",
        name: "domain",
        type: "string",
        required: true,
        default: "",
        placeholder: "example.com",
        displayOptions: {
          show: {
            resource: ["domain"],
            operation: ["create", "get", "delete", "verify"],
          },
        },
        description: "The domain name",
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: ["domain"],
            operation: ["getAll"],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: ["domain"],
            operation: ["getAll"],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: ["domain"],
            operation: ["getAll"],
          },
        },
      },
      {
        displayName: "Slug",
        name: "templateSlugParam",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["get", "update", "delete", "getMergeTags", "getHtml"],
          },
        },
        description: "Template slug (URL-friendly identifier)",
      },
      {
        displayName: "Name",
        name: "templateName",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["create"],
          },
        },
        description: "Name of the template",
      },
      {
        displayName: "Content Type",
        name: "templateContentType",
        type: "options",
        default: "html",
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["create"],
          },
        },
        options: [
          { name: "HTML", value: "html" },
          { name: "JSON (Topol)", value: "json" },
        ],
        description: "Which kind of content to provide",
      },
      {
        displayName: "HTML",
        name: "templateHtml",
        type: "string",
        typeOptions: { rows: 6 },
        default: "",
        required: true,
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["create"],
            templateContentType: ["html"],
          },
        },
        description: "HTML content for the template",
      },
      {
        displayName: "JSON",
        name: "templateJson",
        type: "string",
        typeOptions: { rows: 6 },
        default: "",
        required: true,
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["create"],
            templateContentType: ["json"],
          },
        },
        description: "Topol visual editor JSON content",
      },
      {
        displayName: "Additional Fields",
        name: "templateCreateFields",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["create"],
          },
        },
        options: [
          {
            displayName: "Folder ID",
            name: "folderId",
            type: "number",
            default: 0,
            description:
              "Folder ID to create the template in. Use the Folder resource to find one.",
          },
          {
            displayName: "Project ID",
            name: "projectId",
            type: "number",
            default: 0,
            description: "Project ID to create the template in",
          },
          {
            displayName: "Purpose",
            name: "purpose",
            type: "options",
            default: "transactional",
            options: [
              { name: "Transactional", value: "transactional" },
              { name: "Campaign", value: "campaign" },
            ],
            description:
              "What the template is for. Transactional (the default) is triggered by one user's action - a receipt, password reset or alert. Campaign is marketing sent to an audience list, and is the only kind a campaign can send. This cannot be changed after creation, so a newsletter created as transactional has to be rebuilt.",
          },
        ],
      },
      {
        displayName: "Update Fields",
        name: "templateUpdateFields",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["update"],
          },
        },
        options: [
          {
            displayName: "HTML",
            name: "html",
            type: "string",
            typeOptions: { rows: 6 },
            default: "",
            description: "New HTML content (mutually exclusive with JSON)",
          },
          {
            displayName: "JSON",
            name: "json",
            type: "string",
            typeOptions: { rows: 6 },
            default: "",
            description:
              "New Topol JSON content (mutually exclusive with HTML)",
          },
          {
            displayName: "Name",
            name: "name",
            type: "string",
            default: "",
            description: "New name for the template",
          },
          {
            displayName: "Project ID",
            name: "projectId",
            type: "number",
            default: 0,
            description: "Project ID the template lives in",
          },
        ],
      },
      {
        displayName: "Project ID",
        name: "templateScopeProjectId",
        type: "number",
        default: 0,
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["get", "delete", "getMergeTags", "getHtml"],
          },
        },
        description:
          "Project ID. Required for Get HTML. Optional for others (uses team's default project if 0)",
      },
      {
        displayName: "Version",
        name: "templateMergeTagsVersion",
        type: "number",
        default: 0,
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["getMergeTags"],
          },
        },
        description: "Template version. Defaults to the active version when 0",
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["getAll"],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["getAll"],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["getAll"],
          },
        },
      },
      {
        displayName: "Project ID",
        name: "templateProjectId",
        type: "number",
        default: 0,
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["getAll"],
          },
        },
        description: "Filter templates by project ID",
      },
      {
        displayName: "Purpose",
        name: "templatePurpose",
        type: "options",
        default: "",
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["getAll"],
          },
        },
        options: [
          { name: "Any", value: "" },
          { name: "Transactional", value: "transactional" },
          { name: "Campaign", value: "campaign" },
        ],
        description:
          "Filter templates by purpose. Campaign returns only the templates a campaign can actually send.",
      },
      {
        displayName: "Folder ID",
        name: "templateFolderId",
        type: "number",
        default: 0,
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["getAll"],
          },
        },
        description:
          "Filter templates by folder ID. A folder outside the resolved project is an error rather than an empty list, so a wrong ID cannot be mistaken for an empty folder. Use the Folder resource to find one.",
      },
      {
        displayName: "Page",
        name: "templatePage",
        type: "number",
        typeOptions: {
          minValue: 1,
        },
        default: 1,
        displayOptions: {
          show: {
            resource: ["template"],
            operation: ["getAll"],
          },
        },
        description: "Pagination page number",
      },
      {
        displayName: "Webhook ID",
        name: "webhookId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["get", "update", "delete"],
          },
        },
        description: "The webhook ID",
      },
      {
        displayName: "Name",
        name: "webhookName",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
          },
        },
        description: "Name of the webhook",
      },
      {
        displayName: "Target URL",
        name: "webhookUrl",
        type: "string",
        required: true,
        default: "",
        placeholder: "https://example.com/lettr-events",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
          },
        },
        description: "URL where webhook events will be sent",
      },
      {
        displayName: "Auth Type",
        name: "webhookAuthType",
        type: "options",
        default: "none",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
          },
        },
        options: [
          { name: "None", value: "none" },
          { name: "Basic", value: "basic" },
          { name: "OAuth2", value: "oauth2" },
        ],
      },
      {
        displayName: "Auth Username",
        name: "webhookAuthUsername",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
            webhookAuthType: ["basic"],
          },
        },
      },
      {
        displayName: "Auth Password",
        name: "webhookAuthPassword",
        type: "string",
        typeOptions: { password: true },
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
            webhookAuthType: ["basic"],
          },
        },
      },
      {
        displayName: "OAuth Client ID",
        name: "webhookOauthClientId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
            webhookAuthType: ["oauth2"],
          },
        },
      },
      {
        displayName: "OAuth Client Secret",
        name: "webhookOauthClientSecret",
        type: "string",
        typeOptions: { password: true },
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
            webhookAuthType: ["oauth2"],
          },
        },
      },
      {
        displayName: "OAuth Token URL",
        name: "webhookOauthTokenUrl",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
            webhookAuthType: ["oauth2"],
          },
        },
      },
      {
        displayName: "Events Mode",
        name: "webhookEventsMode",
        type: "options",
        default: "all",
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
          },
        },
        options: [
          { name: "All Events", value: "all" },
          { name: "Selected Events", value: "selected" },
        ],
      },
      {
        displayName: "Events",
        name: "webhookEvents",
        type: "multiOptions",
        default: [],
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["create"],
            webhookEventsMode: ["selected"],
          },
        },
        options: webhookEventOptions,
        description: "Event types to subscribe to",
      },
      {
        displayName: "Update Fields",
        name: "webhookUpdateFields",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["update"],
          },
        },
        options: [
          {
            displayName: "Active",
            name: "active",
            type: "boolean",
            default: true,
            description: "Whether the webhook is enabled",
          },
          {
            displayName: "Auth Password",
            name: "authPassword",
            type: "string",
            typeOptions: { password: true },
            default: "",
          },
          {
            displayName: "Auth Type",
            name: "authType",
            type: "options",
            default: "none",
            options: [
              { name: "None", value: "none" },
              { name: "Basic", value: "basic" },
              { name: "OAuth2", value: "oauth2" },
            ],
          },
          {
            displayName: "Auth Username",
            name: "authUsername",
            type: "string",
            default: "",
          },
          {
            displayName: "Events",
            name: "events",
            type: "multiOptions",
            default: [],
            options: webhookEventOptions,
            description: "Event types to subscribe to",
          },
          {
            displayName: "Name",
            name: "name",
            type: "string",
            default: "",
          },
          {
            displayName: "OAuth Client ID",
            name: "oauthClientId",
            type: "string",
            default: "",
          },
          {
            displayName: "OAuth Client Secret",
            name: "oauthClientSecret",
            type: "string",
            typeOptions: { password: true },
            default: "",
          },
          {
            displayName: "OAuth Token URL",
            name: "oauthTokenUrl",
            type: "string",
            default: "",
          },
          {
            displayName: "Target URL",
            name: "url",
            type: "string",
            default: "",
          },
        ],
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["getAll"],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["getAll"],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: ["webhook"],
            operation: ["getAll"],
          },
        },
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "getAll",
        displayOptions: {
          show: {
            resource: ["folder"],
          },
        },
        options: [
          {
            name: "Get Many",
            value: "getAll",
            description: "Get all template folders",
            action: "Get many folders",
          },
        ],
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: ["folder"],
            operation: ["getAll"],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: ["folder"],
            operation: ["getAll"],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: ["folder"],
            operation: ["getAll"],
          },
        },
      },
      {
        displayName: "Project ID",
        name: "folderProjectId",
        type: "number",
        default: 0,
        displayOptions: {
          show: {
            resource: ["folder"],
            operation: ["getAll"],
          },
        },
        description:
          "Filter folders by project ID. Leave at 0 to use the team's default project.",
      },
      {
        displayName: "Purpose",
        name: "folderPurpose",
        type: "options",
        default: "",
        displayOptions: {
          show: {
            resource: ["folder"],
            operation: ["getAll"],
          },
        },
        options: [
          { name: "Any", value: "" },
          { name: "Transactional", value: "transactional" },
          { name: "Campaign", value: "campaign" },
        ],
        description:
          "Filter folders by purpose. A folder's purpose is separate from its templates' - filing a template in a campaign folder does not make the template a campaign template.",
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "getAll",
        displayOptions: {
          show: {
            resource: ["project"],
          },
        },
        options: [
          {
            name: "Get Many",
            value: "getAll",
            description: "Get all projects",
            action: "Get many projects",
          },
        ],
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: ["project"],
            operation: ["getAll"],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: ["project"],
            operation: ["getAll"],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: ["project"],
            operation: ["getAll"],
          },
        },
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "getAll",
        displayOptions: {
          show: {
            resource: ["campaign"],
          },
        },
        options: [
          {
            name: "Get",
            value: "get",
            description: "Get a campaign by ID",
            action: "Get a campaign",
          },
          {
            name: "Get Events",
            value: "getEvents",
            description:
              "List campaign engagement events (open, click, bounce, etc.)",
            action: "Get campaign events",
          },
          {
            name: "Get Many",
            value: "getAll",
            description: "Get many campaigns",
            action: "Get many campaigns",
          },
          {
            name: "Schedule",
            value: "schedule",
            description: "Schedule a campaign for future delivery",
            action: "Schedule a campaign",
          },
          {
            name: "Send",
            value: "send",
            description: "Send a draft campaign immediately",
            action: "Send a campaign",
          },
          {
            name: "Unschedule",
            value: "unschedule",
            description: "Cancel a scheduled campaign and return it to draft",
            action: "Unschedule a campaign",
          },
        ],
      },
      {
        displayName: "Campaign ID",
        name: "campaignId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["get", "getEvents", "send", "schedule", "unschedule"],
          },
        },
        description: "The campaign ID",
      },
      {
        displayName: "Status",
        name: "status",
        type: "options",
        default: "",
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["getAll"],
          },
        },
        options: [
          { name: "Any", value: "" },
          { name: "Draft", value: "draft" },
          { name: "Scheduled", value: "scheduled" },
          { name: "Preparing", value: "preparing" },
          { name: "In Review", value: "in_review" },
          { name: "Sending", value: "sending" },
          { name: "Sent", value: "sent" },
          { name: "Failed", value: "failed" },
        ],
        description: "Filter campaigns by status",
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["getAll"],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["getAll"],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["getAll"],
          },
        },
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["getEvents"],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["getEvents"],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["getEvents"],
          },
        },
      },
      {
        displayName: "Event Type",
        name: "campaignEventType",
        type: "options",
        default: "",
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["getEvents"],
          },
        },
        options: [
          { name: "Any", value: "" },
          { name: "Injection", value: "injection" },
          { name: "Delivery", value: "delivery" },
          { name: "Bounce", value: "bounce" },
          { name: "Spam Complaint", value: "spam_complaint" },
          { name: "Open", value: "open" },
          { name: "Click", value: "click" },
          { name: "List Unsubscribe", value: "list_unsubscribe" },
        ],
        description: "Filter to a single event type. Leave as Any for all",
      },
      {
        displayName: "Event Filters",
        name: "campaignEventFilters",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["getEvents"],
          },
        },
        options: [
          {
            displayName: "Email",
            name: "email",
            type: "string",
            default: "",
            description: "Filter events by recipient email address",
          },
          {
            displayName: "Start Date",
            name: "startDate",
            type: "string",
            default: "",
            placeholder: "2026-05-01",
            description:
              "Only events at or after this time (ISO 8601). A date-only value is treated as the start of that day in UTC",
          },
          {
            displayName: "End Date",
            name: "endDate",
            type: "string",
            default: "",
            placeholder: "2026-05-31",
            description:
              "Only events at or before this time (ISO 8601), inclusive. A date-only value covers the whole of that day in UTC",
          },
        ],
      },
      {
        displayName: "Scheduled At",
        name: "scheduledAt",
        type: "dateTime",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["campaign"],
            operation: ["schedule"],
          },
        },
        description:
          "Future delivery time (ISO 8601). A value without a timezone offset is interpreted as UTC. Must be in the future",
      },
      {
        ...listOperationProperties[0],
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: [
              "listGetAll",
              "contactGetAll",
              "topicGetAll",
              "propertyGetAll",
              "segmentGetAll",
            ],
          },
        },
      },
      {
        ...listOperationProperties[1],
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: [
              "listGetAll",
              "contactGetAll",
              "topicGetAll",
              "propertyGetAll",
              "segmentGetAll",
            ],
            returnAll: [false],
          },
        },
      },
      {
        ...listOperationProperties[2],
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: [
              "listGetAll",
              "contactGetAll",
              "topicGetAll",
              "propertyGetAll",
              "segmentGetAll",
            ],
          },
        },
      },
      {
        displayName: "Page",
        name: "audiencePage",
        type: "number",
        typeOptions: {
          minValue: 1,
        },
        default: 1,
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: [
              "listGetAll",
              "contactGetAll",
              "topicGetAll",
              "propertyGetAll",
              "segmentGetAll",
            ],
          },
        },
        description: "Pagination page number to start from",
      },
      {
        displayName: "List ID",
        name: "audienceListId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: [
              "listGet",
              "listUpdate",
              "listDelete",
              "contactAttachList",
              "contactDetachList",
            ],
          },
        },
        description: "The audience list ID",
      },
      {
        displayName: "Contact ID",
        name: "audienceContactId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: [
              "contactGet",
              "contactUpdate",
              "contactDelete",
              "contactAttachList",
              "contactDetachList",
              "contactSubscribeTopic",
              "contactUnsubscribeTopic",
            ],
          },
        },
        description: "The audience contact ID",
      },
      {
        displayName: "Topic ID",
        name: "audienceTopicId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: [
              "topicGet",
              "topicUpdate",
              "topicDelete",
              "contactSubscribeTopic",
              "contactUnsubscribeTopic",
            ],
          },
        },
        description: "The audience topic ID",
      },
      {
        displayName: "Property ID",
        name: "audiencePropertyId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["propertyGet", "propertyUpdate", "propertyDelete"],
          },
        },
        description: "The audience property ID",
      },
      {
        displayName: "Segment ID",
        name: "audienceSegmentId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["segmentGet", "segmentUpdate", "segmentDelete"],
          },
        },
        description: "The audience segment ID",
      },
      {
        displayName: "Name",
        name: "audienceListName",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["listCreate", "listUpdate"],
          },
        },
        description: "Name of the audience list",
      },
      {
        displayName: "List IDs",
        name: "audienceListIds",
        type: "string",
        required: true,
        default: "",
        placeholder: "id1, id2, id3",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["listDeleteMany"],
          },
        },
        description:
          "IDs of the lists to delete (comma, semicolon, or newline separated)",
      },
      {
        displayName: "Email",
        name: "contactEmail",
        type: "string",
        required: true,
        default: "",
        placeholder: "jane@example.com",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactCreate"],
          },
        },
        description: "Email address of the contact",
      },
      {
        displayName: "Input Mode",
        name: "contactInputMode",
        type: "options",
        default: "emails",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactCreateMany"],
          },
        },
        options: [
          {
            name: "Email List",
            value: "emails",
            description:
              "One list of addresses; the same lists, topics, and properties apply to every contact",
          },
          {
            name: "Per-Contact Rows",
            value: "contacts",
            description:
              "Each contact carries its own properties, lists, and topic subscriptions",
          },
        ],
        description:
          "How the batch is described. Per-contact rows are needed when contacts differ from each other.",
      },
      {
        displayName: "Emails",
        name: "contactEmails",
        type: "string",
        required: true,
        default: "",
        placeholder: "jane@example.com, joe@example.com",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactCreateMany"],
            contactInputMode: ["emails"],
          },
        },
        description:
          "Email addresses to create (comma, semicolon, or newline separated, max 1000)",
      },
      {
        displayName: "Contacts",
        name: "contactRows",
        type: "json",
        required: true,
        default:
          '[\n  {\n    "email": "jane@example.com",\n    "properties": { "plan": "pro" },\n    "list_ids": ["list-id"],\n    "topics": [{ "id": "topic-id", "subscription": "opt_in" }]\n  }\n]',
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactCreateMany"],
            contactInputMode: ["contacts"],
          },
        },
        description:
          'JSON array of contact rows (max 1000). Only "email" is required per row; "properties", "list_ids", and "topics" are optional and are applied on top of the batch-wide values. A row-level topic "opt_out" wins over a batch-level "opt_in".',
      },
      {
        displayName: "List ID",
        name: "contactListId",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactCreate", "contactCreateMany"],
          },
        },
        description: "Optional list to add the contact(s) to",
      },
      {
        displayName: "Properties",
        name: "propertiesUi",
        type: "fixedCollection",
        typeOptions: {
          multipleValues: true,
        },
        default: {},
        placeholder: "Add Property",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactCreate", "contactCreateMany", "contactUpdate"],
          },
        },
        description:
          "Custom property values. Each name must match a property defined for the team.",
        options: [
          {
            name: "property",
            displayName: "Property",
            values: [
              {
                displayName: "Name",
                name: "name",
                type: "string",
                default: "",
                description: "Property name (key)",
              },
              {
                displayName: "Value",
                name: "value",
                type: "string",
                default: "",
                description: "Property value",
              },
            ],
          },
        ],
      },
      {
        displayName: "Batch Options",
        name: "contactBulkOptions",
        type: "collection",
        default: {},
        placeholder: "Add Batch Option",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactCreateMany"],
          },
        },
        description:
          "Applied to every contact in the batch, on top of anything set on an individual row",
        options: [
          {
            displayName: "List IDs",
            name: "listIds",
            type: "string",
            default: "",
            placeholder: "id1, id2",
            description:
              "Lists every contact in the batch is attached to (comma, semicolon, or newline separated, max 50)",
          },
          {
            displayName: "Topics",
            name: "topics",
            type: "json",
            default: '[{ "id": "topic-id", "subscription": "opt_in" }]',
            description:
              'JSON array of topic subscriptions applied to the whole batch (max 50). Each entry is {"id": "...", "subscription": "opt_in" | "opt_out"}; "subscription" defaults to "opt_in". Use "opt_out" to stop a topic that auto-subscribes new contacts.',
          },
          {
            displayName: "Update Existing",
            name: "updateExisting",
            type: "boolean",
            default: false,
            description:
              "Whether to merge the submitted properties into contacts that already exist. When off, existing contacts keep their properties but are still attached to the requested lists and topics.",
          },
        ],
      },
      {
        displayName: "Double Opt-In",
        name: "doubleOptIn",
        type: "collection",
        default: {},
        placeholder: "Add Double Opt-In Config",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactCreate"],
          },
        },
        description:
          "When set, the contact is created as unverified and receives a confirmation email",
        options: [
          {
            displayName: "From",
            name: "from",
            type: "string",
            default: "",
            placeholder: "no-reply@example.com",
            description: "Sender email address for the confirmation email",
          },
          {
            displayName: "From Name",
            name: "fromName",
            type: "string",
            default: "",
            description: "Sender display name",
          },
          {
            displayName: "Redirect URL",
            name: "redirectUrl",
            type: "string",
            default: "",
            description: "URL to redirect to after the contact confirms",
          },
          {
            displayName: "Subject",
            name: "subject",
            type: "string",
            default: "",
            description: "Subject line of the confirmation email",
          },
          {
            displayName: "Template Slug",
            name: "templateSlug",
            type: "string",
            default: "",
            description: "Template slug used to render the confirmation email",
          },
        ],
      },
      {
        displayName: "Update Fields",
        name: "contactUpdateFields",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactUpdate"],
          },
        },
        options: [
          {
            displayName: "Email",
            name: "email",
            type: "string",
            default: "",
            description: "New email address for the contact",
          },
          {
            displayName: "Status",
            name: "status",
            type: "options",
            default: "subscribed",
            options: [
              { name: "Subscribed", value: "subscribed" },
              { name: "Unsubscribed", value: "unsubscribed" },
            ],
            description: "Subscription status of the contact",
          },
        ],
      },
      {
        displayName: "Contact IDs",
        name: "contactIds",
        type: "string",
        required: true,
        default: "",
        placeholder: "id1, id2",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: [
              "contactBulkAttachLists",
              "contactBulkDetachLists",
              "contactBulkSubscribeTopics",
              "contactBulkUnsubscribeTopics",
            ],
          },
        },
        description: "Contact IDs (comma, semicolon, or newline separated)",
      },
      {
        displayName: "List IDs",
        name: "listIds",
        type: "string",
        required: true,
        default: "",
        placeholder: "id1, id2",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactBulkAttachLists", "contactBulkDetachLists"],
          },
        },
        description: "List IDs (comma, semicolon, or newline separated)",
      },
      {
        displayName: "Topic IDs",
        name: "topicIds",
        type: "string",
        required: true,
        default: "",
        placeholder: "id1, id2",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: [
              "contactBulkSubscribeTopics",
              "contactBulkUnsubscribeTopics",
            ],
          },
        },
        description:
          "Topic IDs (comma, semicolon, or newline separated, max 50)",
      },
      {
        displayName: "Filters",
        name: "contactFilters",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["contactGetAll"],
          },
        },
        options: [
          {
            displayName: "List ID",
            name: "listId",
            type: "string",
            default: "",
            description: "Filter contacts by list ID",
          },
          {
            displayName: "Search",
            name: "search",
            type: "string",
            default: "",
            description: "Search contacts by email address",
          },
          {
            displayName: "Segment ID",
            name: "segmentId",
            type: "string",
            default: "",
            description: "Filter contacts by segment ID",
          },
          {
            displayName: "Status",
            name: "status",
            type: "options",
            default: "subscribed",
            options: [
              { name: "Bounced", value: "bounced" },
              { name: "Complained", value: "complained" },
              { name: "Subscribed", value: "subscribed" },
              { name: "Unsubscribed", value: "unsubscribed" },
              { name: "Unverified", value: "unverified" },
            ],
            description: "Filter contacts by subscription status",
          },
        ],
      },
      {
        displayName: "Name",
        name: "topicName",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["topicCreate"],
          },
        },
        description: "Name of the topic",
      },
      {
        displayName: "Additional Fields",
        name: "topicCreateFields",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["topicCreate"],
          },
        },
        options: [
          {
            displayName: "Default Subscription",
            name: "defaultSubscription",
            type: "options",
            default: "opt_in",
            options: [
              { name: "Opt In", value: "opt_in" },
              { name: "Opt Out", value: "opt_out" },
            ],
            description:
              "Default subscription behavior for new contacts on this topic",
          },
          {
            displayName: "Description",
            name: "description",
            type: "string",
            default: "",
            description: "Description of the topic",
          },
          {
            displayName: "Visibility",
            name: "visibility",
            type: "options",
            default: "private",
            options: [
              { name: "Private", value: "private" },
              { name: "Public", value: "public" },
            ],
            description: "Visibility of the topic (private or public)",
          },
        ],
      },
      {
        displayName: "Update Fields",
        name: "topicUpdateFields",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["topicUpdate"],
          },
        },
        options: [
          {
            displayName: "Description",
            name: "description",
            type: "string",
            default: "",
            description: "New description for the topic",
          },
          {
            displayName: "Name",
            name: "name",
            type: "string",
            default: "",
            description: "New name for the topic",
          },
          {
            displayName: "Visibility",
            name: "visibility",
            type: "options",
            default: "private",
            options: [
              { name: "Private", value: "private" },
              { name: "Public", value: "public" },
            ],
            description: "Visibility of the topic (private or public)",
          },
        ],
      },
      {
        displayName: "Name",
        name: "propertyName",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["propertyCreate"],
          },
        },
        description: "Name of the property",
      },
      {
        displayName: "Type",
        name: "propertyType",
        type: "options",
        default: "string",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["propertyCreate"],
          },
        },
        options: [
          { name: "Boolean", value: "boolean" },
          { name: "Date", value: "date" },
          { name: "JSON", value: "json" },
          { name: "Number", value: "number" },
          { name: "String", value: "string" },
        ],
        description:
          "Data type of the property (cannot be changed after creation)",
      },
      {
        displayName: "Fallback Value",
        name: "propertyFallbackValue",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["propertyCreate", "propertyUpdate"],
          },
        },
        description:
          "Default value used when a contact has no value for this property",
      },
      {
        displayName: "Name",
        name: "segmentName",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["segmentCreate"],
          },
        },
        description: "Name of the segment",
      },
      {
        displayName: "List ID",
        name: "segmentListId",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["segmentCreate"],
          },
        },
        description: "Optional list to restrict the segment to",
      },
      {
        displayName: "Conditions (JSON)",
        name: "segmentConditionsJson",
        type: "string",
        typeOptions: {
          rows: 6,
        },
        required: true,
        default: "",
        placeholder:
          '{"groups":[{"conditions":[{"field":"email","operator":"contains","value":"@example.com"}]}]}',
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["segmentCreate"],
          },
        },
        description:
          "Segment conditions as JSON. Groups are joined by OR; conditions within a group by AND.",
      },
      {
        displayName: "List ID",
        name: "segmentListIdFilter",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["segmentGetAll"],
          },
        },
        description: "Filter segments by list ID",
      },
      {
        displayName: "Update Fields",
        name: "segmentUpdateFields",
        type: "collection",
        default: {},
        displayOptions: {
          show: {
            resource: [
              "audienceContact",
              "audienceList",
              "audienceProperty",
              "audienceSegment",
              "audienceTopic",
            ],
            operation: ["segmentUpdate"],
          },
        },
        options: [
          {
            displayName: "Conditions (JSON)",
            name: "conditionsJson",
            type: "string",
            typeOptions: {
              rows: 6,
            },
            default: "",
            description: "New segment conditions as JSON",
          },
          {
            displayName: "List ID",
            name: "listId",
            type: "string",
            default: "",
            description: "Restrict the segment to a single list",
          },
          {
            displayName: "Name",
            name: "name",
            type: "string",
            default: "",
            description: "New name for the segment",
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const resource = this.getNodeParameter("resource", itemIndex) as string;
        const operation = this.getNodeParameter(
          "operation",
          itemIndex,
        ) as string;

        if (resource === "email") {
          if (operation === "send" || operation === "schedule") {
            const from = this.getNodeParameter("from", itemIndex) as string;
            const toInput = this.getNodeParameter("to", itemIndex) as string;
            const subject = this.getNodeParameter(
              "subject",
              itemIndex,
            ) as string;
            const html = this.getNodeParameter("html", itemIndex) as string;
            const text = this.getNodeParameter("text", itemIndex) as string;
            const templateSlug = this.getNodeParameter(
              "templateSlug",
              itemIndex,
            ) as string;
            const additionalFields = this.getNodeParameter(
              "additionalFields",
              itemIndex,
              {},
            ) as IDataObject;

            if (!html && !text && !templateSlug) {
              throw new NodeOperationError(
                this.getNode(),
                "Provide at least one of: HTML, Text, or Template Slug.",
                { itemIndex },
              );
            }

            const subjectTrimmed = (subject ?? "").trim();
            if (!templateSlug && !subjectTrimmed) {
              throw new NodeOperationError(
                this.getNode(),
                '"Subject" is required unless sending via a template.',
                { itemIndex },
              );
            }

            const to = splitRecipientList(toInput);
            if (to.length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                '"To" must contain at least one valid recipient.',
                { itemIndex },
              );
            }

            const body: IDataObject = {
              from,
              to,
            };
            if (subject) body.subject = subject;

            if (html) body.html = html;
            if (text) body.text = text;
            if (templateSlug) body.template_slug = templateSlug;
            if (additionalFields.fromName)
              body.from_name = additionalFields.fromName;
            if (additionalFields.replyTo)
              body.reply_to = additionalFields.replyTo;
            if (additionalFields.replyToName)
              body.reply_to_name = additionalFields.replyToName;
            if (additionalFields.ampHtml)
              body.amp_html = additionalFields.ampHtml;
            if (additionalFields.projectId)
              body.project_id = additionalFields.projectId;
            if (additionalFields.templateVersion) {
              body.template_version = additionalFields.templateVersion;
            }
            if (additionalFields.campaignId)
              body.campaign_id = additionalFields.campaignId;

            if (additionalFields.cc) {
              body.cc = splitRecipientList(additionalFields.cc as string);
            }

            if (additionalFields.bcc) {
              body.bcc = splitRecipientList(additionalFields.bcc as string);
            }

            if (additionalFields.metadataJson) {
              body.metadata = parseOptionalJson(
                additionalFields.metadataJson as string,
                "Metadata (JSON)",
                itemIndex,
                this,
              );
            }

            if (additionalFields.substitutionDataJson) {
              body.substitution_data = parseOptionalJson(
                additionalFields.substitutionDataJson as string,
                "Substitution Data (JSON)",
                itemIndex,
                this,
              );
            }

            if (additionalFields.optionsJson) {
              body.options = parseOptionalJson(
                additionalFields.optionsJson as string,
                "Options (JSON)",
                itemIndex,
                this,
              );
            }

            if (additionalFields.attachmentsJson) {
              body.attachments = parseOptionalJson(
                additionalFields.attachmentsJson as string,
                "Attachments (JSON)",
                itemIndex,
                this,
              );
            }

            const endpoint =
              operation === "schedule" ? "/emails/scheduled" : "/emails";
            if (operation === "schedule") {
              const scheduledAt = this.getNodeParameter(
                "scheduledAt",
                itemIndex,
              ) as string;
              if (!scheduledAt) {
                throw new NodeOperationError(
                  this.getNode(),
                  '"Scheduled At" is required when scheduling an email.',
                  { itemIndex },
                );
              }
              body.scheduled_at = scheduledAt;
            }

            // Only a live send can be replayed. A scheduled transmission is
            // created once and then cancelled or edited by ID, so a key there
            // would be silently meaningless.
            const headers: IDataObject = {};
            if (operation === "send" && additionalFields.idempotencyKey) {
              headers["Idempotency-Key"] = String(
                additionalFields.idempotencyKey,
              );
            }

            const response = await lettrApiRequest.call(
              this,
              "POST",
              endpoint,
              itemIndex,
              body,
              {},
              headers,
            );

            returnData.push({
              json: response,
              pairedItem: itemIndex,
            });
          }

          if (operation === "getScheduled" || operation === "cancelScheduled") {
            const transmissionId = this.getNodeParameter(
              "transmissionId",
              itemIndex,
            ) as string;
            const method: IHttpRequestMethods =
              operation === "cancelScheduled" ? "DELETE" : "GET";
            const response = await lettrApiRequest.call(
              this,
              method,
              `/emails/scheduled/${transmissionId}`,
              itemIndex,
            );

            returnData.push({
              json: response,
              pairedItem: itemIndex,
            });
          }

          if (operation === "getEvents") {
            const returnAll = this.getNodeParameter(
              "returnAll",
              itemIndex,
            ) as boolean;
            const simplify = this.getNodeParameter(
              "simplify",
              itemIndex,
              true,
            ) as boolean;
            const limit = this.getNodeParameter(
              "limit",
              itemIndex,
              50,
            ) as number;
            const eventTypes = this.getNodeParameter(
              "eventTypes",
              itemIndex,
              [],
            ) as string[];
            const filters = this.getNodeParameter(
              "eventFilters",
              itemIndex,
              {},
            ) as IDataObject;

            const queryBase: IDataObject = {};
            if (eventTypes.length > 0) queryBase.events = eventTypes.join(",");
            if (filters.recipients) queryBase.recipients = filters.recipients;
            if (filters.fromDate) queryBase.from = filters.fromDate;
            if (filters.toDate) queryBase.to = filters.toDate;
            if (filters.transmissionId)
              queryBase.transmissions = filters.transmissionId;
            if (filters.bounceClasses)
              queryBase.bounce_classes = filters.bounceClasses;

            returnData.push(
              ...(await cursorGetMany.call(
                this,
                "/emails/events",
                itemIndex,
                queryBase,
                "per_page",
                returnAll,
                limit,
                simplify,
                (response) => {
                  const data = getResponseData(response);
                  const eventsContainer = (data.events as IDataObject) ?? {};
                  const list = Array.isArray(eventsContainer.data)
                    ? (eventsContainer.data as IDataObject[])
                    : [];
                  const pagination =
                    (eventsContainer.pagination as IDataObject) ?? {};
                  return {
                    list,
                    nextCursor:
                      (pagination.next_cursor as string | undefined) ??
                      undefined,
                  };
                },
                (entries) => ({ data: { events: { data: entries } } }),
              )),
            );
          }

          if (operation === "get") {
            const requestId = this.getNodeParameter(
              "requestId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "GET",
              `/emails/${requestId}`,
              itemIndex,
            );

            returnData.push({
              json: response,
              pairedItem: itemIndex,
            });
          }

          if (operation === "getAll") {
            const returnAll = this.getNodeParameter(
              "returnAll",
              itemIndex,
            ) as boolean;
            const simplify = this.getNodeParameter(
              "simplify",
              itemIndex,
              true,
            ) as boolean;
            const limit = this.getNodeParameter(
              "limit",
              itemIndex,
              50,
            ) as number;
            const recipients = this.getNodeParameter(
              "recipients",
              itemIndex,
              "",
            ) as string;
            const fromDate = this.getNodeParameter(
              "fromDate",
              itemIndex,
              "",
            ) as string;
            const toDate = this.getNodeParameter(
              "toDate",
              itemIndex,
              "",
            ) as string;
            const startingCursor = this.getNodeParameter(
              "cursor",
              itemIndex,
              "",
            ) as string;

            const queryBase: IDataObject = {};
            if (recipients) queryBase.recipients = recipients;
            if (fromDate) queryBase.from = fromDate;
            if (toDate) queryBase.to = toDate;

            if (!returnAll) {
              const qs: IDataObject = {
                ...queryBase,
                per_page: limit,
              };
              if (startingCursor) qs.cursor = startingCursor;

              const response = await lettrApiRequest.call(
                this,
                "GET",
                "/emails",
                itemIndex,
                {},
                qs,
              );

              if (!simplify) {
                returnData.push({
                  json: response,
                  pairedItem: itemIndex,
                });
              } else {
                const list = getResponseList(response, "emails");
                for (const entry of list) {
                  returnData.push({
                    json: entry,
                    pairedItem: itemIndex,
                  });
                }
              }
            } else {
              const entries: IDataObject[] = [];
              let cursor: string | undefined = startingCursor || undefined;

              do {
                const qs: IDataObject = {
                  ...queryBase,
                  per_page: 100,
                };
                if (cursor) qs.cursor = cursor;

                const response = await lettrApiRequest.call(
                  this,
                  "GET",
                  "/emails",
                  itemIndex,
                  {},
                  qs,
                );

                entries.push(...getResponseList(response, "emails"));
                const pagination = getPagination(response);
                cursor =
                  (pagination.next_cursor as string | undefined) ?? undefined;
              } while (cursor);

              if (!simplify) {
                returnData.push({
                  json: {
                    data: {
                      emails: entries,
                    },
                  },
                  pairedItem: itemIndex,
                });
              } else {
                for (const entry of entries) {
                  returnData.push({
                    json: entry,
                    pairedItem: itemIndex,
                  });
                }
              }
            }
          }
        }

        if (resource === "domain" && operation === "create") {
          const domain = this.getNodeParameter("domain", itemIndex) as string;
          const response = await lettrApiRequest.call(
            this,
            "POST",
            "/domains",
            itemIndex,
            { domain },
          );

          returnData.push({ json: response, pairedItem: itemIndex });
        }

        if (
          resource === "domain" &&
          (operation === "get" ||
            operation === "delete" ||
            operation === "verify")
        ) {
          const domain = this.getNodeParameter("domain", itemIndex) as string;
          const method: IHttpRequestMethods =
            operation === "delete"
              ? "DELETE"
              : operation === "verify"
                ? "POST"
                : "GET";
          const endpoint =
            operation === "verify"
              ? `/domains/${domain}/verify`
              : `/domains/${domain}`;

          const response = await lettrApiRequest.call(
            this,
            method,
            endpoint,
            itemIndex,
          );
          returnData.push({ json: response, pairedItem: itemIndex });
        }

        if (resource === "domain" && operation === "getAll") {
          const returnAll = this.getNodeParameter(
            "returnAll",
            itemIndex,
          ) as boolean;
          const limit = this.getNodeParameter("limit", itemIndex, 50) as number;
          const simplify = this.getNodeParameter(
            "simplify",
            itemIndex,
            true,
          ) as boolean;
          const response = await lettrApiRequest.call(
            this,
            "GET",
            "/domains",
            itemIndex,
          );
          const list = getResponseList(response, "domains");
          const outputList = returnAll ? list : list.slice(0, limit);

          if (!simplify) {
            const outputResponse: IDataObject = {
              ...response,
            };
            outputResponse.data = {
              ...(getResponseData(response) as IDataObject),
              domains: outputList,
            };

            returnData.push({
              json: outputResponse,
              pairedItem: itemIndex,
            });
          } else {
            for (const entry of outputList) {
              returnData.push({
                json: entry,
                pairedItem: itemIndex,
              });
            }
          }
        }

        if (resource === "template" && operation === "create") {
          const name = this.getNodeParameter(
            "templateName",
            itemIndex,
          ) as string;
          const contentType = this.getNodeParameter(
            "templateContentType",
            itemIndex,
          ) as string;
          const additional = this.getNodeParameter(
            "templateCreateFields",
            itemIndex,
            {},
          ) as IDataObject;

          const body: IDataObject = { name };
          if (contentType === "html") {
            body.html = this.getNodeParameter(
              "templateHtml",
              itemIndex,
            ) as string;
          } else {
            body.json = this.getNodeParameter(
              "templateJson",
              itemIndex,
            ) as string;
          }
          if (additional.projectId) body.project_id = additional.projectId;
          if (additional.folderId) body.folder_id = additional.folderId;
          if (additional.purpose) body.purpose = additional.purpose;

          const response = await lettrApiRequest.call(
            this,
            "POST",
            "/templates",
            itemIndex,
            body,
          );
          returnData.push({ json: response, pairedItem: itemIndex });
        }

        if (resource === "template" && operation === "update") {
          const slug = this.getNodeParameter(
            "templateSlugParam",
            itemIndex,
          ) as string;
          const fields = this.getNodeParameter(
            "templateUpdateFields",
            itemIndex,
            {},
          ) as IDataObject;

          if (fields.html && fields.json) {
            throw new NodeOperationError(
              this.getNode(),
              "Provide either HTML or JSON, not both.",
              { itemIndex },
            );
          }

          const body: IDataObject = {};
          if (fields.name) body.name = fields.name;
          if (fields.html) body.html = fields.html;
          if (fields.json) body.json = fields.json;
          if (fields.projectId) body.project_id = fields.projectId;

          const hasChange =
            body.name !== undefined ||
            body.html !== undefined ||
            body.json !== undefined;
          if (!hasChange) {
            throw new NodeOperationError(
              this.getNode(),
              "Provide Name, HTML, or JSON to update the template.",
              { itemIndex },
            );
          }

          const response = await lettrApiRequest.call(
            this,
            "PUT",
            `/templates/${slug}`,
            itemIndex,
            body,
          );
          returnData.push({ json: response, pairedItem: itemIndex });
        }

        if (
          resource === "template" &&
          (operation === "get" ||
            operation === "delete" ||
            operation === "getMergeTags")
        ) {
          const slug = this.getNodeParameter(
            "templateSlugParam",
            itemIndex,
          ) as string;
          const projectId = this.getNodeParameter(
            "templateScopeProjectId",
            itemIndex,
            0,
          ) as number;

          const qs: IDataObject = {};
          if (projectId > 0) qs.project_id = projectId;

          if (operation === "getMergeTags") {
            const version = this.getNodeParameter(
              "templateMergeTagsVersion",
              itemIndex,
              0,
            ) as number;
            if (version > 0) qs.version = version;
          }

          const method: IHttpRequestMethods =
            operation === "delete" ? "DELETE" : "GET";
          const endpoint =
            operation === "getMergeTags"
              ? `/templates/${slug}/merge-tags`
              : `/templates/${slug}`;

          const response = await lettrApiRequest.call(
            this,
            method,
            endpoint,
            itemIndex,
            {},
            qs,
          );
          returnData.push({ json: response, pairedItem: itemIndex });
        }

        if (resource === "template" && operation === "getHtml") {
          const slug = this.getNodeParameter(
            "templateSlugParam",
            itemIndex,
          ) as string;
          const projectId = this.getNodeParameter(
            "templateScopeProjectId",
            itemIndex,
            0,
          ) as number;

          if (!projectId) {
            throw new NodeOperationError(
              this.getNode(),
              '"Project ID" is required for Get HTML.',
              { itemIndex },
            );
          }

          const response = await lettrApiRequest.call(
            this,
            "GET",
            "/templates/html",
            itemIndex,
            {},
            { slug, project_id: projectId },
          );
          returnData.push({ json: response, pairedItem: itemIndex });
        }

        if (resource === "template" && operation === "getAll") {
          const returnAll = this.getNodeParameter(
            "returnAll",
            itemIndex,
          ) as boolean;
          const limit = this.getNodeParameter("limit", itemIndex, 50) as number;
          const simplify = this.getNodeParameter(
            "simplify",
            itemIndex,
            true,
          ) as boolean;
          const projectId = this.getNodeParameter(
            "templateProjectId",
            itemIndex,
            0,
          ) as number;
          const startingPage = this.getNodeParameter(
            "templatePage",
            itemIndex,
            1,
          ) as number;
          const purpose = this.getNodeParameter(
            "templatePurpose",
            itemIndex,
            "",
          ) as string;
          const folderId = this.getNodeParameter(
            "templateFolderId",
            itemIndex,
            0,
          ) as number;

          const queryBase: IDataObject = {};
          if (projectId > 0) queryBase.project_id = projectId;
          if (purpose) queryBase.purpose = purpose;
          if (folderId > 0) queryBase.folder_id = folderId;

          if (!returnAll) {
            const qs: IDataObject = {
              ...queryBase,
              per_page: limit,
              page: startingPage,
            };

            const response = await lettrApiRequest.call(
              this,
              "GET",
              "/templates",
              itemIndex,
              {},
              qs,
            );

            if (!simplify) {
              returnData.push({
                json: response,
                pairedItem: itemIndex,
              });
            } else {
              const list = getResponseList(response, "templates");
              for (const entry of list) {
                returnData.push({
                  json: entry,
                  pairedItem: itemIndex,
                });
              }
            }
          } else {
            const entries: IDataObject[] = [];
            let page = Math.max(1, startingPage);
            let hasMore = true;

            while (hasMore) {
              const qs: IDataObject = {
                ...queryBase,
                per_page: 100,
                page,
              };

              const response = await lettrApiRequest.call(
                this,
                "GET",
                "/templates",
                itemIndex,
                {},
                qs,
              );

              entries.push(...getResponseList(response, "templates"));
              const pagination = getPagination(response);
              const currentPage = Number(pagination.current_page ?? page);
              const lastPage = Number(pagination.last_page ?? currentPage);
              hasMore = currentPage < lastPage;
              page = currentPage + 1;
            }

            if (!simplify) {
              returnData.push({
                json: {
                  data: {
                    templates: entries,
                  },
                },
                pairedItem: itemIndex,
              });
            } else {
              for (const entry of entries) {
                returnData.push({
                  json: entry,
                  pairedItem: itemIndex,
                });
              }
            }
          }
        }

        if (resource === "webhook" && operation === "create") {
          const name = this.getNodeParameter(
            "webhookName",
            itemIndex,
          ) as string;
          const url = this.getNodeParameter("webhookUrl", itemIndex) as string;
          const authType = this.getNodeParameter(
            "webhookAuthType",
            itemIndex,
          ) as string;
          const eventsMode = this.getNodeParameter(
            "webhookEventsMode",
            itemIndex,
          ) as string;

          const body: IDataObject = {
            name,
            url,
            auth_type: authType,
            events_mode: eventsMode,
          };

          if (authType === "basic") {
            const authUsername = this.getNodeParameter(
              "webhookAuthUsername",
              itemIndex,
              "",
            ) as string;
            const authPassword = this.getNodeParameter(
              "webhookAuthPassword",
              itemIndex,
              "",
            ) as string;
            if (!authUsername || !authPassword) {
              throw new NodeOperationError(
                this.getNode(),
                '"Auth Username" and "Auth Password" are required when Auth Type is "Basic".',
                { itemIndex },
              );
            }
            body.auth_username = authUsername;
            body.auth_password = authPassword;
          }

          if (authType === "oauth2") {
            const clientId = this.getNodeParameter(
              "webhookOauthClientId",
              itemIndex,
              "",
            ) as string;
            const clientSecret = this.getNodeParameter(
              "webhookOauthClientSecret",
              itemIndex,
              "",
            ) as string;
            const tokenUrl = this.getNodeParameter(
              "webhookOauthTokenUrl",
              itemIndex,
              "",
            ) as string;
            if (!clientId || !clientSecret || !tokenUrl) {
              throw new NodeOperationError(
                this.getNode(),
                '"OAuth Client ID", "OAuth Client Secret", and "OAuth Token URL" are all required when Auth Type is "OAuth2".',
                { itemIndex },
              );
            }
            body.oauth_client_id = clientId;
            body.oauth_client_secret = clientSecret;
            body.oauth_token_url = tokenUrl;
          }

          if (eventsMode === "selected") {
            const events = this.getNodeParameter(
              "webhookEvents",
              itemIndex,
              [],
            ) as string[];
            if (events.length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                'Select at least one event when Events Mode is "Selected".',
                { itemIndex },
              );
            }
            body.events = events;
          }

          const response = await lettrApiRequest.call(
            this,
            "POST",
            "/webhooks",
            itemIndex,
            body,
          );
          returnData.push({ json: response, pairedItem: itemIndex });
        }

        if (
          resource === "webhook" &&
          (operation === "get" || operation === "delete")
        ) {
          const webhookId = this.getNodeParameter(
            "webhookId",
            itemIndex,
          ) as string;
          const method: IHttpRequestMethods =
            operation === "delete" ? "DELETE" : "GET";
          const response = await lettrApiRequest.call(
            this,
            method,
            `/webhooks/${webhookId}`,
            itemIndex,
          );
          returnData.push({ json: response, pairedItem: itemIndex });
        }

        if (resource === "webhook" && operation === "update") {
          const webhookId = this.getNodeParameter(
            "webhookId",
            itemIndex,
          ) as string;
          const fields = this.getNodeParameter(
            "webhookUpdateFields",
            itemIndex,
            {},
          ) as IDataObject;

          const body: IDataObject = {};
          if (fields.name !== undefined && fields.name !== "")
            body.name = fields.name;
          if (fields.url !== undefined && fields.url !== "")
            body.url = fields.url;
          if (fields.authType !== undefined) body.auth_type = fields.authType;
          if (fields.authUsername !== undefined && fields.authUsername !== "") {
            body.auth_username = fields.authUsername;
          }
          if (fields.authPassword !== undefined && fields.authPassword !== "") {
            body.auth_password = fields.authPassword;
          }
          if (
            fields.oauthClientId !== undefined &&
            fields.oauthClientId !== ""
          ) {
            body.oauth_client_id = fields.oauthClientId;
          }
          if (
            fields.oauthClientSecret !== undefined &&
            fields.oauthClientSecret !== ""
          ) {
            body.oauth_client_secret = fields.oauthClientSecret;
          }
          if (
            fields.oauthTokenUrl !== undefined &&
            fields.oauthTokenUrl !== ""
          ) {
            body.oauth_token_url = fields.oauthTokenUrl;
          }
          if (
            Array.isArray(fields.events) &&
            (fields.events as unknown[]).length > 0
          ) {
            body.events = fields.events;
          }
          if (fields.active !== undefined) body.active = fields.active;

          if (Object.keys(body).length === 0) {
            throw new NodeOperationError(
              this.getNode(),
              "Provide at least one field to update.",
              { itemIndex },
            );
          }

          const response = await lettrApiRequest.call(
            this,
            "PUT",
            `/webhooks/${webhookId}`,
            itemIndex,
            body,
          );
          returnData.push({ json: response, pairedItem: itemIndex });
        }

        if (resource === "webhook" && operation === "getAll") {
          const returnAll = this.getNodeParameter(
            "returnAll",
            itemIndex,
          ) as boolean;
          const limit = this.getNodeParameter("limit", itemIndex, 50) as number;
          const simplify = this.getNodeParameter(
            "simplify",
            itemIndex,
            true,
          ) as boolean;
          const response = await lettrApiRequest.call(
            this,
            "GET",
            "/webhooks",
            itemIndex,
          );
          const list = getResponseList(response, "webhooks");
          const outputList = returnAll ? list : list.slice(0, limit);

          if (!simplify) {
            const outputResponse: IDataObject = {
              ...response,
            };
            outputResponse.data = {
              ...(getResponseData(response) as IDataObject),
              webhooks: outputList,
            };

            returnData.push({
              json: outputResponse,
              pairedItem: itemIndex,
            });
          } else {
            for (const entry of outputList) {
              returnData.push({
                json: entry,
                pairedItem: itemIndex,
              });
            }
          }
        }

        if (resource === "folder" && operation === "getAll") {
          const returnAll = this.getNodeParameter(
            "returnAll",
            itemIndex,
          ) as boolean;
          const limit = this.getNodeParameter("limit", itemIndex, 50) as number;
          const simplify = this.getNodeParameter(
            "simplify",
            itemIndex,
            true,
          ) as boolean;
          const projectId = this.getNodeParameter(
            "folderProjectId",
            itemIndex,
            0,
          ) as number;
          const purpose = this.getNodeParameter(
            "folderPurpose",
            itemIndex,
            "",
          ) as string;

          const queryBase: IDataObject = {};
          if (projectId > 0) queryBase.project_id = projectId;
          if (purpose) queryBase.purpose = purpose;

          if (!returnAll) {
            const qs: IDataObject = {
              ...queryBase,
              per_page: limit,
              page: 1,
            };
            const response = await lettrApiRequest.call(
              this,
              "GET",
              "/folders",
              itemIndex,
              {},
              qs,
            );

            if (!simplify) {
              returnData.push({ json: response, pairedItem: itemIndex });
            } else {
              for (const entry of getResponseList(response, "folders")) {
                returnData.push({ json: entry, pairedItem: itemIndex });
              }
            }
          } else {
            const entries: IDataObject[] = [];
            let page = 1;
            let hasMore = true;

            while (hasMore) {
              const qs: IDataObject = { ...queryBase, per_page: 100, page };
              const response = await lettrApiRequest.call(
                this,
                "GET",
                "/folders",
                itemIndex,
                {},
                qs,
              );
              entries.push(...getResponseList(response, "folders"));
              const pagination = getPagination(response);
              const currentPage = Number(pagination.current_page ?? page);
              const lastPage = Number(pagination.last_page ?? currentPage);
              hasMore = currentPage < lastPage;
              page = currentPage + 1;
            }

            if (!simplify) {
              returnData.push({
                json: { data: { folders: entries } },
                pairedItem: itemIndex,
              });
            } else {
              for (const entry of entries) {
                returnData.push({ json: entry, pairedItem: itemIndex });
              }
            }
          }
        }

        if (resource === "project" && operation === "getAll") {
          const returnAll = this.getNodeParameter(
            "returnAll",
            itemIndex,
          ) as boolean;
          const limit = this.getNodeParameter("limit", itemIndex, 50) as number;
          const simplify = this.getNodeParameter(
            "simplify",
            itemIndex,
            true,
          ) as boolean;

          if (!returnAll) {
            const qs: IDataObject = { per_page: limit, page: 1 };
            const response = await lettrApiRequest.call(
              this,
              "GET",
              "/projects",
              itemIndex,
              {},
              qs,
            );

            if (!simplify) {
              returnData.push({ json: response, pairedItem: itemIndex });
            } else {
              for (const entry of getResponseList(response, "projects")) {
                returnData.push({ json: entry, pairedItem: itemIndex });
              }
            }
          } else {
            const entries: IDataObject[] = [];
            let page = 1;
            let hasMore = true;

            while (hasMore) {
              const qs: IDataObject = { per_page: 100, page };
              const response = await lettrApiRequest.call(
                this,
                "GET",
                "/projects",
                itemIndex,
                {},
                qs,
              );
              entries.push(...getResponseList(response, "projects"));
              const pagination = getPagination(response);
              const currentPage = Number(pagination.current_page ?? page);
              const lastPage = Number(pagination.last_page ?? currentPage);
              hasMore = currentPage < lastPage;
              page = currentPage + 1;
            }

            if (!simplify) {
              returnData.push({
                json: { data: { projects: entries } },
                pairedItem: itemIndex,
              });
            } else {
              for (const entry of entries) {
                returnData.push({ json: entry, pairedItem: itemIndex });
              }
            }
          }
        }
        if (resource === "campaign") {
          if (operation === "getAll") {
            const returnAll = this.getNodeParameter(
              "returnAll",
              itemIndex,
            ) as boolean;
            const limit = this.getNodeParameter(
              "limit",
              itemIndex,
              50,
            ) as number;
            const simplify = this.getNodeParameter(
              "simplify",
              itemIndex,
              true,
            ) as boolean;
            const status = this.getNodeParameter(
              "status",
              itemIndex,
              "",
            ) as string;

            const queryBase: IDataObject = {};
            if (status) queryBase.status = status;

            returnData.push(
              ...(await paginatedGetMany.call(
                this,
                "/campaigns",
                "campaigns",
                itemIndex,
                queryBase,
                returnAll,
                Math.min(limit, 100),
                simplify,
                1,
              )),
            );
          }

          if (operation === "get") {
            const campaignId = this.getNodeParameter(
              "campaignId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "GET",
              `/campaigns/${campaignId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "getEvents") {
            const campaignId = this.getNodeParameter(
              "campaignId",
              itemIndex,
            ) as string;
            const returnAll = this.getNodeParameter(
              "returnAll",
              itemIndex,
            ) as boolean;
            const simplify = this.getNodeParameter(
              "simplify",
              itemIndex,
              true,
            ) as boolean;
            const limit = this.getNodeParameter(
              "limit",
              itemIndex,
              50,
            ) as number;
            const eventType = this.getNodeParameter(
              "campaignEventType",
              itemIndex,
              "",
            ) as string;
            const filters = this.getNodeParameter(
              "campaignEventFilters",
              itemIndex,
              {},
            ) as IDataObject;

            const queryBase: IDataObject = {};
            if (eventType) queryBase.event_type = eventType;
            if (filters.email) queryBase.email = filters.email;
            if (filters.startDate) queryBase.start_date = filters.startDate;
            if (filters.endDate) queryBase.end_date = filters.endDate;

            returnData.push(
              ...(await cursorGetMany.call(
                this,
                `/campaigns/${campaignId}/events`,
                itemIndex,
                queryBase,
                "limit",
                returnAll,
                Math.min(limit, 100),
                simplify,
                (response) => {
                  const data = getResponseData(response);
                  const list = Array.isArray(data.events)
                    ? (data.events as IDataObject[])
                    : [];
                  return {
                    list,
                    nextCursor:
                      (data.next_cursor as string | undefined) ?? undefined,
                  };
                },
                (entries) => ({ data: { events: entries } }),
              )),
            );
          }

          if (operation === "send" || operation === "unschedule") {
            const campaignId = this.getNodeParameter(
              "campaignId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "POST",
              `/campaigns/${campaignId}/${operation}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "schedule") {
            const campaignId = this.getNodeParameter(
              "campaignId",
              itemIndex,
            ) as string;
            const scheduledAt = this.getNodeParameter(
              "scheduledAt",
              itemIndex,
            ) as string;
            if (!scheduledAt) {
              throw new NodeOperationError(
                this.getNode(),
                '"Scheduled At" is required when scheduling a campaign.',
                { itemIndex },
              );
            }
            const response = await lettrApiRequest.call(
              this,
              "POST",
              `/campaigns/${campaignId}/schedule`,
              itemIndex,
              { scheduled_at: scheduledAt },
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }
        }
        if (resource.startsWith("audience")) {
          // --- Lists ---
          if (operation === "listGetAll") {
            const returnAll = this.getNodeParameter(
              "returnAll",
              itemIndex,
            ) as boolean;
            const limit = this.getNodeParameter(
              "limit",
              itemIndex,
              50,
            ) as number;
            const simplify = this.getNodeParameter(
              "simplify",
              itemIndex,
              true,
            ) as boolean;
            const page = this.getNodeParameter(
              "audiencePage",
              itemIndex,
              1,
            ) as number;
            returnData.push(
              ...(await paginatedGetMany.call(
                this,
                "/audience/lists",
                "lists",
                itemIndex,
                {},
                returnAll,
                limit,
                simplify,
                page,
              )),
            );
          }

          if (operation === "listGet") {
            const listId = this.getNodeParameter(
              "audienceListId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "GET",
              `/audience/lists/${listId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "listCreate") {
            const name = this.getNodeParameter(
              "audienceListName",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "POST",
              "/audience/lists",
              itemIndex,
              { name },
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "listUpdate") {
            const listId = this.getNodeParameter(
              "audienceListId",
              itemIndex,
            ) as string;
            const name = this.getNodeParameter(
              "audienceListName",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "PATCH",
              `/audience/lists/${listId}`,
              itemIndex,
              { name },
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "listDelete") {
            const listId = this.getNodeParameter(
              "audienceListId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "DELETE",
              `/audience/lists/${listId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "listDeleteMany") {
            const listIds = splitRecipientList(
              this.getNodeParameter("audienceListIds", itemIndex) as string,
            );
            if (listIds.length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                '"List IDs" must contain at least one ID.',
                { itemIndex },
              );
            }
            const response = await lettrApiRequest.call(
              this,
              "DELETE",
              "/audience/lists/bulk",
              itemIndex,
              { list_ids: listIds },
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          // --- Contacts ---
          if (operation === "contactGetAll") {
            const returnAll = this.getNodeParameter(
              "returnAll",
              itemIndex,
            ) as boolean;
            const limit = this.getNodeParameter(
              "limit",
              itemIndex,
              50,
            ) as number;
            const simplify = this.getNodeParameter(
              "simplify",
              itemIndex,
              true,
            ) as boolean;
            const page = this.getNodeParameter(
              "audiencePage",
              itemIndex,
              1,
            ) as number;
            const filters = this.getNodeParameter(
              "contactFilters",
              itemIndex,
              {},
            ) as IDataObject;

            const queryBase: IDataObject = {};
            if (filters.search) queryBase.search = filters.search;
            if (filters.status) queryBase.status = filters.status;
            if (filters.listId) queryBase.list_id = filters.listId;
            if (filters.segmentId) queryBase.segment_id = filters.segmentId;

            returnData.push(
              ...(await paginatedGetMany.call(
                this,
                "/audience/contacts",
                "contacts",
                itemIndex,
                queryBase,
                returnAll,
                limit,
                simplify,
                page,
              )),
            );
          }

          if (operation === "contactGet") {
            const contactId = this.getNodeParameter(
              "audienceContactId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "GET",
              `/audience/contacts/${contactId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "contactCreate") {
            const email = this.getNodeParameter(
              "contactEmail",
              itemIndex,
            ) as string;
            const listId = this.getNodeParameter(
              "contactListId",
              itemIndex,
              "",
            ) as string;
            const propertiesUi = this.getNodeParameter(
              "propertiesUi",
              itemIndex,
              {},
            ) as IDataObject;
            const doubleOptIn = this.getNodeParameter(
              "doubleOptIn",
              itemIndex,
              {},
            ) as IDataObject;

            const body: IDataObject = { email };
            if (listId) body.list_id = listId;
            const props = collectProperties(propertiesUi);
            if (Object.keys(props).length > 0) body.properties = props;

            if (Object.keys(doubleOptIn).length > 0) {
              const doi: IDataObject = {};
              if (doubleOptIn.from) doi.from = doubleOptIn.from;
              if (doubleOptIn.fromName) doi.from_name = doubleOptIn.fromName;
              if (doubleOptIn.subject) doi.subject = doubleOptIn.subject;
              if (doubleOptIn.templateSlug)
                doi.template_slug = doubleOptIn.templateSlug;
              if (doubleOptIn.redirectUrl)
                doi.redirect_url = doubleOptIn.redirectUrl;

              const missing = [
                "from",
                "subject",
                "template_slug",
                "redirect_url",
              ].filter((key) => !(key in doi));
              if (missing.length > 0) {
                throw new NodeOperationError(
                  this.getNode(),
                  `Double Opt-In requires: ${missing.join(", ")}.`,
                  { itemIndex },
                );
              }
              body.double_opt_in = doi;
            }

            const response = await lettrApiRequest.call(
              this,
              "POST",
              "/audience/contacts",
              itemIndex,
              body,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "contactCreateMany") {
            // Defaults to "emails" so workflows saved before per-contact rows
            // existed keep sending the exact same payload.
            const inputMode = this.getNodeParameter(
              "contactInputMode",
              itemIndex,
              "emails",
            ) as string;

            const body: IDataObject = {};

            if (inputMode === "contacts") {
              const rows = parseOptionalJson(
                this.getNodeParameter("contactRows", itemIndex) as string,
                "Contacts",
                itemIndex,
                this,
              );
              if (!Array.isArray(rows) || rows.length === 0) {
                throw new NodeOperationError(
                  this.getNode(),
                  '"Contacts" must be a JSON array with at least one row.',
                  { itemIndex },
                );
              }
              const missing = rows.findIndex(
                (row) => !row || typeof row !== "object" || !row.email,
              );
              if (missing !== -1) {
                throw new NodeOperationError(
                  this.getNode(),
                  `"Contacts" row ${missing} is missing the required "email" field.`,
                  { itemIndex },
                );
              }
              body.contacts = rows;
            } else {
              const emails = splitRecipientList(
                this.getNodeParameter("contactEmails", itemIndex) as string,
              );
              if (emails.length === 0) {
                throw new NodeOperationError(
                  this.getNode(),
                  '"Emails" must contain at least one address.',
                  { itemIndex },
                );
              }
              body.emails = emails;
            }

            const listId = this.getNodeParameter(
              "contactListId",
              itemIndex,
              "",
            ) as string;
            const propertiesUi = this.getNodeParameter(
              "propertiesUi",
              itemIndex,
              {},
            ) as IDataObject;
            const batchOptions = this.getNodeParameter(
              "contactBulkOptions",
              itemIndex,
              {},
            ) as IDataObject;

            if (listId) body.list_id = listId;
            const props = collectProperties(propertiesUi);
            if (Object.keys(props).length > 0) body.properties = props;

            const batchListIds = splitRecipientList(
              (batchOptions.listIds as string) ?? "",
            );
            if (batchListIds.length > 0) body.list_ids = batchListIds;

            if (batchOptions.topics) {
              const topics = parseOptionalJson(
                batchOptions.topics as string,
                "Topics",
                itemIndex,
                this,
              );
              if (!Array.isArray(topics)) {
                throw new NodeOperationError(
                  this.getNode(),
                  '"Topics" must be a JSON array.',
                  { itemIndex },
                );
              }
              if (topics.length > 0) body.topics = topics;
            }

            if (batchOptions.updateExisting !== undefined) {
              body.update_existing = batchOptions.updateExisting as boolean;
            }

            const response = await lettrApiRequest.call(
              this,
              "POST",
              "/audience/contacts/bulk",
              itemIndex,
              body,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "contactUpdate") {
            const contactId = this.getNodeParameter(
              "audienceContactId",
              itemIndex,
            ) as string;
            const fields = this.getNodeParameter(
              "contactUpdateFields",
              itemIndex,
              {},
            ) as IDataObject;
            const propertiesUi = this.getNodeParameter(
              "propertiesUi",
              itemIndex,
              {},
            ) as IDataObject;

            const body: IDataObject = {};
            if (fields.email) body.email = fields.email;
            if (fields.status) body.status = fields.status;
            const props = collectProperties(propertiesUi);
            if (Object.keys(props).length > 0) body.properties = props;

            if (Object.keys(body).length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                "Provide at least one field to update.",
                { itemIndex },
              );
            }

            const response = await lettrApiRequest.call(
              this,
              "PATCH",
              `/audience/contacts/${contactId}`,
              itemIndex,
              body,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "contactDelete") {
            const contactId = this.getNodeParameter(
              "audienceContactId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "DELETE",
              `/audience/contacts/${contactId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (
            operation === "contactAttachList" ||
            operation === "contactDetachList"
          ) {
            const contactId = this.getNodeParameter(
              "audienceContactId",
              itemIndex,
            ) as string;
            const listId = this.getNodeParameter(
              "audienceListId",
              itemIndex,
            ) as string;
            const method: IHttpRequestMethods =
              operation === "contactDetachList" ? "DELETE" : "POST";
            const response = await lettrApiRequest.call(
              this,
              method,
              `/audience/contacts/${contactId}/lists/${listId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (
            operation === "contactSubscribeTopic" ||
            operation === "contactUnsubscribeTopic"
          ) {
            const contactId = this.getNodeParameter(
              "audienceContactId",
              itemIndex,
            ) as string;
            const topicId = this.getNodeParameter(
              "audienceTopicId",
              itemIndex,
            ) as string;
            const method: IHttpRequestMethods =
              operation === "contactUnsubscribeTopic" ? "DELETE" : "POST";
            const response = await lettrApiRequest.call(
              this,
              method,
              `/audience/contacts/${contactId}/topics/${topicId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (
            operation === "contactBulkAttachLists" ||
            operation === "contactBulkDetachLists"
          ) {
            const contactIds = splitRecipientList(
              this.getNodeParameter("contactIds", itemIndex) as string,
            );
            const listIds = splitRecipientList(
              this.getNodeParameter("listIds", itemIndex) as string,
            );
            if (contactIds.length === 0 || listIds.length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                '"Contact IDs" and "List IDs" must each contain at least one ID.',
                { itemIndex },
              );
            }
            const method: IHttpRequestMethods =
              operation === "contactBulkDetachLists" ? "DELETE" : "POST";
            const response = await lettrApiRequest.call(
              this,
              method,
              "/audience/contacts/lists/bulk",
              itemIndex,
              { contact_ids: contactIds, list_ids: listIds },
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (
            operation === "contactBulkSubscribeTopics" ||
            operation === "contactBulkUnsubscribeTopics"
          ) {
            const contactIds = splitRecipientList(
              this.getNodeParameter("contactIds", itemIndex) as string,
            );
            const topicIds = splitRecipientList(
              this.getNodeParameter("topicIds", itemIndex) as string,
            );
            if (contactIds.length === 0 || topicIds.length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                '"Contact IDs" and "Topic IDs" must each contain at least one ID.',
                { itemIndex },
              );
            }
            const method: IHttpRequestMethods =
              operation === "contactBulkUnsubscribeTopics" ? "DELETE" : "POST";
            const response = await lettrApiRequest.call(
              this,
              method,
              "/audience/contacts/topics/bulk",
              itemIndex,
              { contact_ids: contactIds, topic_ids: topicIds },
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          // --- Topics ---
          if (operation === "topicGetAll") {
            const returnAll = this.getNodeParameter(
              "returnAll",
              itemIndex,
            ) as boolean;
            const limit = this.getNodeParameter(
              "limit",
              itemIndex,
              50,
            ) as number;
            const simplify = this.getNodeParameter(
              "simplify",
              itemIndex,
              true,
            ) as boolean;
            const page = this.getNodeParameter(
              "audiencePage",
              itemIndex,
              1,
            ) as number;
            returnData.push(
              ...(await paginatedGetMany.call(
                this,
                "/audience/topics",
                "topics",
                itemIndex,
                {},
                returnAll,
                limit,
                simplify,
                page,
              )),
            );
          }

          if (operation === "topicGet") {
            const topicId = this.getNodeParameter(
              "audienceTopicId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "GET",
              `/audience/topics/${topicId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "topicCreate") {
            const name = this.getNodeParameter(
              "topicName",
              itemIndex,
            ) as string;
            const fields = this.getNodeParameter(
              "topicCreateFields",
              itemIndex,
              {},
            ) as IDataObject;

            const body: IDataObject = { name };
            if (fields.description) body.description = fields.description;
            if (fields.defaultSubscription) {
              body.default_subscription = fields.defaultSubscription;
            }
            if (fields.visibility) body.visibility = fields.visibility;

            const response = await lettrApiRequest.call(
              this,
              "POST",
              "/audience/topics",
              itemIndex,
              body,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "topicUpdate") {
            const topicId = this.getNodeParameter(
              "audienceTopicId",
              itemIndex,
            ) as string;
            const fields = this.getNodeParameter(
              "topicUpdateFields",
              itemIndex,
              {},
            ) as IDataObject;

            const body: IDataObject = {};
            if (fields.name) body.name = fields.name;
            if (fields.description !== undefined && fields.description !== "") {
              body.description = fields.description;
            }
            if (fields.visibility) body.visibility = fields.visibility;

            if (Object.keys(body).length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                "Provide at least one field to update.",
                { itemIndex },
              );
            }

            const response = await lettrApiRequest.call(
              this,
              "PATCH",
              `/audience/topics/${topicId}`,
              itemIndex,
              body,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "topicDelete") {
            const topicId = this.getNodeParameter(
              "audienceTopicId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "DELETE",
              `/audience/topics/${topicId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          // --- Properties ---
          if (operation === "propertyGetAll") {
            const returnAll = this.getNodeParameter(
              "returnAll",
              itemIndex,
            ) as boolean;
            const limit = this.getNodeParameter(
              "limit",
              itemIndex,
              50,
            ) as number;
            const simplify = this.getNodeParameter(
              "simplify",
              itemIndex,
              true,
            ) as boolean;
            const page = this.getNodeParameter(
              "audiencePage",
              itemIndex,
              1,
            ) as number;
            returnData.push(
              ...(await paginatedGetMany.call(
                this,
                "/audience/properties",
                "properties",
                itemIndex,
                {},
                returnAll,
                limit,
                simplify,
                page,
              )),
            );
          }

          if (operation === "propertyGet") {
            const propertyId = this.getNodeParameter(
              "audiencePropertyId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "GET",
              `/audience/properties/${propertyId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "propertyCreate") {
            const name = this.getNodeParameter(
              "propertyName",
              itemIndex,
            ) as string;
            const type = this.getNodeParameter(
              "propertyType",
              itemIndex,
            ) as string;
            const fallbackValue = this.getNodeParameter(
              "propertyFallbackValue",
              itemIndex,
              "",
            ) as string;

            const body: IDataObject = { name, type };
            if (fallbackValue !== "") body.fallback_value = fallbackValue;

            const response = await lettrApiRequest.call(
              this,
              "POST",
              "/audience/properties",
              itemIndex,
              body,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "propertyUpdate") {
            const propertyId = this.getNodeParameter(
              "audiencePropertyId",
              itemIndex,
            ) as string;
            const fallbackValue = this.getNodeParameter(
              "propertyFallbackValue",
              itemIndex,
              "",
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "PATCH",
              `/audience/properties/${propertyId}`,
              itemIndex,
              { fallback_value: fallbackValue },
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "propertyDelete") {
            const propertyId = this.getNodeParameter(
              "audiencePropertyId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "DELETE",
              `/audience/properties/${propertyId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          // --- Segments ---
          if (operation === "segmentGetAll") {
            const returnAll = this.getNodeParameter(
              "returnAll",
              itemIndex,
            ) as boolean;
            const limit = this.getNodeParameter(
              "limit",
              itemIndex,
              50,
            ) as number;
            const simplify = this.getNodeParameter(
              "simplify",
              itemIndex,
              true,
            ) as boolean;
            const page = this.getNodeParameter(
              "audiencePage",
              itemIndex,
              1,
            ) as number;
            const listIdFilter = this.getNodeParameter(
              "segmentListIdFilter",
              itemIndex,
              "",
            ) as string;

            const queryBase: IDataObject = {};
            if (listIdFilter) queryBase.list_id = listIdFilter;

            returnData.push(
              ...(await paginatedGetMany.call(
                this,
                "/audience/segments",
                "segments",
                itemIndex,
                queryBase,
                returnAll,
                limit,
                simplify,
                page,
              )),
            );
          }

          if (operation === "segmentGet") {
            const segmentId = this.getNodeParameter(
              "audienceSegmentId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "GET",
              `/audience/segments/${segmentId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "segmentCreate") {
            const name = this.getNodeParameter(
              "segmentName",
              itemIndex,
            ) as string;
            const listId = this.getNodeParameter(
              "segmentListId",
              itemIndex,
              "",
            ) as string;
            const conditionsJson = this.getNodeParameter(
              "segmentConditionsJson",
              itemIndex,
            ) as string;
            const conditions = parseOptionalJson(
              conditionsJson,
              "Conditions (JSON)",
              itemIndex,
              this,
            );

            const body: IDataObject = { name, conditions };
            if (listId) body.list_id = listId;

            const response = await lettrApiRequest.call(
              this,
              "POST",
              "/audience/segments",
              itemIndex,
              body,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "segmentUpdate") {
            const segmentId = this.getNodeParameter(
              "audienceSegmentId",
              itemIndex,
            ) as string;
            const fields = this.getNodeParameter(
              "segmentUpdateFields",
              itemIndex,
              {},
            ) as IDataObject;

            const body: IDataObject = {};
            if (fields.name) body.name = fields.name;
            if (fields.listId) body.list_id = fields.listId;
            if (fields.conditionsJson) {
              body.conditions = parseOptionalJson(
                fields.conditionsJson as string,
                "Conditions (JSON)",
                itemIndex,
                this,
              );
            }

            if (Object.keys(body).length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                "Provide at least one field to update.",
                { itemIndex },
              );
            }

            const response = await lettrApiRequest.call(
              this,
              "PATCH",
              `/audience/segments/${segmentId}`,
              itemIndex,
              body,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }

          if (operation === "segmentDelete") {
            const segmentId = this.getNodeParameter(
              "audienceSegmentId",
              itemIndex,
            ) as string;
            const response = await lettrApiRequest.call(
              this,
              "DELETE",
              `/audience/segments/${segmentId}`,
              itemIndex,
            );
            returnData.push({ json: response, pairedItem: itemIndex });
          }
        }
      } catch (error) {
        if (this.continueOnFail()) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          returnData.push({
            json: {
              error: message,
            },
            pairedItem: itemIndex,
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}
