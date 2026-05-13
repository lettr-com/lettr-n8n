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
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

const LETTR_BASE_URL = 'https://app.lettr.com/api';

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
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method,
		baseURL: LETTR_BASE_URL,
		url: endpoint,
		json: true,
		body,
		qs,
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
			'lettrApi',
			options,
		)) as IDataObject;
	} catch (error) {
		const err = error as { response?: { body?: unknown; data?: unknown }; message?: string };
		const body = err?.response?.body ?? err?.response?.data;
		let detail = '';

		if (body && typeof body === 'object') {
			const b = body as IDataObject;
			const apiMessage = (b.message ?? b.error ?? '') as string;
			const errors = b.errors as IDataObject | undefined;
			const fieldErrors =
				errors && typeof errors === 'object'
					? Object.entries(errors)
							.map(([field, msgs]) => {
								const list = Array.isArray(msgs) ? (msgs as string[]).join('; ') : String(msgs);
								return `${field}: ${list}`;
							})
							.join(' | ')
					: '';
			detail = [apiMessage, fieldErrors].filter(Boolean).join(' — ');
		} else if (typeof body === 'string') {
			detail = body;
		}

		throw new NodeApiError(this.getNode(), error as JsonObject, {
			itemIndex,
			message: detail || err?.message || 'Lettr API request failed',
		});
	}
}

const webhookEventOptions = [
	{ name: 'Engagement: AMP Click', value: 'engagement.amp_click' },
	{ name: 'Engagement: AMP Initial Open', value: 'engagement.amp_initial_open' },
	{ name: 'Engagement: AMP Open', value: 'engagement.amp_open' },
	{ name: 'Engagement: Click', value: 'engagement.click' },
	{ name: 'Engagement: Initial Open', value: 'engagement.initial_open' },
	{ name: 'Engagement: Open', value: 'engagement.open' },
	{ name: 'Generation: Failure', value: 'generation.generation_failure' },
	{ name: 'Generation: Rejection', value: 'generation.generation_rejection' },
	{ name: 'Message: Bounce', value: 'message.bounce' },
	{ name: 'Message: Delay', value: 'message.delay' },
	{ name: 'Message: Delivery', value: 'message.delivery' },
	{ name: 'Message: Injection', value: 'message.injection' },
	{ name: 'Message: Out of Band', value: 'message.out_of_band' },
	{ name: 'Message: Policy Rejection', value: 'message.policy_rejection' },
	{ name: 'Message: Spam Complaint', value: 'message.spam_complaint' },
	{ name: 'Relay: Delivery', value: 'relay.relay_delivery' },
	{ name: 'Relay: Injection', value: 'relay.relay_injection' },
	{ name: 'Relay: Permanent Failure', value: 'relay.relay_permfail' },
	{ name: 'Relay: Rejection', value: 'relay.relay_rejection' },
	{ name: 'Relay: Temporary Failure', value: 'relay.relay_tempfail' },
	{ name: 'Unsubscribe: Link', value: 'unsubscribe.link_unsubscribe' },
	{ name: 'Unsubscribe: List', value: 'unsubscribe.list_unsubscribe' },
];

const listOperationProperties: INodeProperties[] = [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: {
			minValue: 1,
			maxValue: 250,
		},
		default: 50,
		description: 'Max number of results to return',
		displayOptions: {
			show: {
				returnAll: [false],
			},
		},
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description: 'Whether to split array results into separate output items',
	},
];

export class Lettr implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Lettr',
		name: 'lettr',
		icon: 'file:lettr.svg',
		group: ['output'],
		version: 1,
		usableAsTool: true,
		documentationUrl: 'https://docs.lettr.com/api-reference/introduction',
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Interact with Lettr transactional email APIs',
		defaults: {
			name: 'Lettr',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'lettrApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'email',
				options: [
					{
						name: 'Email',
						value: 'email',
					},
					{
						name: 'Domain',
						value: 'domain',
					},
					{
						name: 'Project',
						value: 'project',
					},
					{
						name: 'Template',
						value: 'template',
					},
					{
						name: 'Webhook',
						value: 'webhook',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'send',
				displayOptions: {
					show: {
						resource: ['email'],
					},
				},
				options: [
					{
						name: 'Cancel Scheduled',
						value: 'cancelScheduled',
						description: 'Cancel a scheduled email transmission',
						action: 'Cancel a scheduled email',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get an email request by ID',
						action: 'Get an email request',
					},
					{
						name: 'Get Events',
						value: 'getEvents',
						description: 'List email events (delivery, bounce, open, click, etc.)',
						action: 'Get email events',
					},
					{
						name: 'Get Scheduled',
						value: 'getScheduled',
						description: 'Get a scheduled email transmission by ID',
						action: 'Get a scheduled email',
					},
					{
						name: 'Schedule',
						value: 'schedule',
						description: 'Schedule a transactional email for future delivery',
						action: 'Schedule a transactional email',
					},
					{
						name: 'Send',
						value: 'send',
						description: 'Send a transactional email',
						action: 'Send a transactional email',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getAll',
				displayOptions: {
					show: {
						resource: ['domain'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Register a new sending domain',
						action: 'Create a domain',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a sending domain',
						action: 'Delete a domain',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a sending domain by name',
						action: 'Get a domain',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get all sending domains',
						action: 'Get many domains',
					},
					{
						name: 'Verify',
						value: 'verify',
						description: "Verify a domain's DNS records",
						action: 'Verify a domain',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getAll',
				displayOptions: {
					show: {
						resource: ['template'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new email template',
						action: 'Create a template',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a template',
						action: 'Delete a template',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a template by slug',
						action: 'Get a template',
					},
					{
						name: 'Get HTML',
						value: 'getHtml',
						description: "Get a template's active HTML and merge tags",
						action: 'Get template HTML',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get all templates',
						action: 'Get many templates',
					},
					{
						name: 'Get Merge Tags',
						value: 'getMergeTags',
						description: 'Get the merge tags for a template version',
						action: 'Get template merge tags',
					},
					{
						name: 'Update',
						value: 'update',
						description: "Update a template's name or content",
						action: 'Update a template',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getAll',
				displayOptions: {
					show: {
						resource: ['webhook'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new webhook',
						action: 'Create a webhook',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a webhook',
						action: 'Delete a webhook',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a webhook by ID',
						action: 'Get a webhook',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get all webhooks',
						action: 'Get many webhooks',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update an existing webhook',
						action: 'Update a webhook',
					},
				],
			},
			{
				displayName: 'Request ID',
				name: 'requestId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['get'],
					},
				},
				description: 'ID of the email request to retrieve',
			},
			{
				displayName: 'From Email',
				name: 'from',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'support@example.com',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['send', 'schedule'],
					},
				},
				description: 'Sender email address',
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'alice@example.com, bob@example.com',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['send', 'schedule'],
					},
				},
				description: 'Recipient email addresses (comma, semicolon, or newline separated)',
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['send', 'schedule'],
					},
				},
				description:
					"Email subject line. Required unless using a template — when omitted with a template, the template's subject is used",
			},
			{
				displayName: 'HTML',
				name: 'html',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['send', 'schedule'],
					},
				},
				description: 'HTML body for the email',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['send', 'schedule'],
					},
				},
				description: 'Plain-text body for the email',
			},
			{
				displayName: 'Template Slug',
				name: 'templateSlug',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['send', 'schedule'],
					},
				},
				description: 'Template slug to render instead of raw HTML/Text',
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				default: {},
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['send', 'schedule'],
					},
				},
				options: [
					{
						displayName: 'Amp HTML',
						name: 'ampHtml',
						type: 'string',
						default: '',
						description: 'AMP HTML body',
					},
					{
						displayName: 'BCC',
						name: 'bcc',
						type: 'string',
						default: '',
						description: 'BCC recipient emails (comma, semicolon, or newline separated)',
					},
					{
						displayName: 'Campaign ID',
						name: 'campaignId',
						type: 'number',
						default: 0,
						description: 'Optional campaign identifier',
					},
					{
						displayName: 'CC',
						name: 'cc',
						type: 'string',
						default: '',
						description: 'CC recipient emails (comma, semicolon, or newline separated)',
					},
					{
						displayName: 'From Name',
						name: 'fromName',
						type: 'string',
						default: '',
						description: 'Display name for the sender',
					},
					{
						displayName: 'Metadata (JSON)',
						name: 'metadataJson',
						type: 'string',
						typeOptions: {
							rows: 4,
						},
						default: '',
						placeholder: '{"orderId":"12345"}',
						description: 'Metadata object as JSON',
					},
					{
						displayName: 'Options (JSON)',
						name: 'optionsJson',
						type: 'string',
						typeOptions: {
							rows: 4,
						},
						default: '',
						placeholder: '{"track_clicks":true}',
						description: 'Provider options object as JSON',
					},
					{
						displayName: 'Project ID',
						name: 'projectId',
						type: 'number',
						default: 0,
						description: 'Project ID used for routing and analytics',
					},
					{
						displayName: 'Reply-To',
						name: 'replyTo',
						type: 'string',
						default: '',
						description: 'Reply-to email address',
					},
					{
						displayName: 'Reply-To Name',
						name: 'replyToName',
						type: 'string',
						default: '',
						description: 'Reply-to display name',
					},
					{
						displayName: 'Substitution Data (JSON)',
						name: 'substitutionDataJson',
						type: 'string',
						typeOptions: {
							rows: 4,
						},
						default: '',
						placeholder: '{"first_name":"Alice"}',
						description: 'Template substitution object as JSON',
					},
					{
						displayName: 'Template Version',
						name: 'templateVersion',
						type: 'number',
						default: 0,
						description: 'Template version ID',
					},
					{
						displayName: 'Attachments (JSON)',
						name: 'attachmentsJson',
						type: 'string',
						typeOptions: {
							rows: 4,
						},
						default: '',
						placeholder: '[{"name":"invoice.pdf","type":"application/pdf","data":"<base64>"}]',
						description: 'Array of attachment objects as JSON',
					},
				],
			},
			{
				displayName: 'Scheduled At',
				name: 'scheduledAt',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['schedule'],
					},
				},
				description:
					'When to send the email (UTC). Must be at least 5 minutes in the future and within 3 days',
			},
			{
				displayName: 'Transmission ID',
				name: 'transmissionId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getScheduled', 'cancelScheduled'],
					},
				},
				description: 'ID returned when the email was scheduled',
			},
			{
				...listOperationProperties[0],
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getEvents'],
					},
				},
			},
			{
				...listOperationProperties[1],
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getEvents'],
						returnAll: [false],
					},
				},
			},
			{
				...listOperationProperties[2],
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getEvents'],
					},
				},
			},
			{
				displayName: 'Event Types',
				name: 'eventTypes',
				type: 'multiOptions',
				default: [],
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getEvents'],
					},
				},
				options: [
					{ name: 'AMP Click', value: 'amp_click' },
					{ name: 'AMP Initial Open', value: 'amp_initial_open' },
					{ name: 'AMP Open', value: 'amp_open' },
					{ name: 'Bounce', value: 'bounce' },
					{ name: 'Click', value: 'click' },
					{ name: 'Delay', value: 'delay' },
					{ name: 'Delivery', value: 'delivery' },
					{ name: 'Generation Failure', value: 'generation_failure' },
					{ name: 'Generation Rejection', value: 'generation_rejection' },
					{ name: 'Initial Open', value: 'initial_open' },
					{ name: 'Injection', value: 'injection' },
					{ name: 'Link Unsubscribe', value: 'link_unsubscribe' },
					{ name: 'List Unsubscribe', value: 'list_unsubscribe' },
					{ name: 'Open', value: 'open' },
					{ name: 'Out of Band', value: 'out_of_band' },
					{ name: 'Policy Rejection', value: 'policy_rejection' },
					{ name: 'Spam Complaint', value: 'spam_complaint' },
				],
				description: 'Filter to specific event types. Leave empty to include all',
			},
			{
				displayName: 'Event Filters',
				name: 'eventFilters',
				type: 'collection',
				default: {},
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getEvents'],
					},
				},
				options: [
					{
						displayName: 'Bounce Classes',
						name: 'bounceClasses',
						type: 'string',
						default: '',
						description: 'Comma-separated bounce classification codes',
					},
					{
						displayName: 'From Date',
						name: 'fromDate',
						type: 'string',
						default: '',
						placeholder: '2025-01-01',
						description: 'Lower date bound. Defaults to 10 days ago',
					},
					{
						displayName: 'Recipients',
						name: 'recipients',
						type: 'string',
						default: '',
						description: 'Comma-separated recipient email addresses to filter by',
					},
					{
						displayName: 'To Date',
						name: 'toDate',
						type: 'string',
						default: '',
						placeholder: '2025-01-31',
						description: 'Upper date bound. Defaults to now',
					},
					{
						displayName: 'Transmission ID',
						name: 'transmissionId',
						type: 'string',
						default: '',
						description: 'Filter events to a single transmission (request_id)',
					},
				],
			},
			{
				...listOperationProperties[0],
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getAll'],
					},
				},
			},
			{
				...listOperationProperties[1],
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getAll'],
						returnAll: [false],
					},
				},
			},
			{
				...listOperationProperties[2],
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getAll'],
					},
				},
			},
			{
				displayName: 'Recipients Filter',
				name: 'recipients',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getAll'],
					},
				},
				description: 'Only return requests where one of these recipients appears',
			},
			{
				displayName: 'From Date',
				name: 'fromDate',
				type: 'string',
				default: '',
				placeholder: '2025-01-01',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getAll'],
					},
				},
				description: 'Lower date bound (YYYY-MM-DD)',
			},
			{
				displayName: 'To Date',
				name: 'toDate',
				type: 'string',
				default: '',
				placeholder: '2025-01-31',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getAll'],
					},
				},
				description: 'Upper date bound (YYYY-MM-DD)',
			},
			{
				displayName: 'Cursor',
				name: 'cursor',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['getAll'],
					},
				},
				description: 'Cursor token for pagination',
			},
			{
				displayName: 'Domain',
				name: 'domain',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'example.com',
				displayOptions: {
					show: {
						resource: ['domain'],
						operation: ['create', 'get', 'delete', 'verify'],
					},
				},
				description: 'The domain name',
			},
			{
				...listOperationProperties[0],
				displayOptions: {
					show: {
						resource: ['domain'],
						operation: ['getAll'],
					},
				},
			},
			{
				...listOperationProperties[1],
				displayOptions: {
					show: {
						resource: ['domain'],
						operation: ['getAll'],
						returnAll: [false],
					},
				},
			},
			{
				...listOperationProperties[2],
				displayOptions: {
					show: {
						resource: ['domain'],
						operation: ['getAll'],
					},
				},
			},
			{
				displayName: 'Slug',
				name: 'templateSlugParam',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['get', 'update', 'delete', 'getMergeTags', 'getHtml'],
					},
				},
				description: 'Template slug (URL-friendly identifier)',
			},
			{
				displayName: 'Name',
				name: 'templateName',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['create'],
					},
				},
				description: 'Name of the template',
			},
			{
				displayName: 'Content Type',
				name: 'templateContentType',
				type: 'options',
				default: 'html',
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['create'],
					},
				},
				options: [
					{ name: 'HTML', value: 'html' },
					{ name: 'JSON (Topol)', value: 'json' },
				],
				description: 'Which kind of content to provide',
			},
			{
				displayName: 'HTML',
				name: 'templateHtml',
				type: 'string',
				typeOptions: { rows: 6 },
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['create'],
						templateContentType: ['html'],
					},
				},
				description: 'HTML content for the template',
			},
			{
				displayName: 'JSON',
				name: 'templateJson',
				type: 'string',
				typeOptions: { rows: 6 },
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['create'],
						templateContentType: ['json'],
					},
				},
				description: 'Topol visual editor JSON content',
			},
			{
				displayName: 'Additional Fields',
				name: 'templateCreateFields',
				type: 'collection',
				default: {},
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['create'],
					},
				},
				options: [
					{
						displayName: 'Folder ID',
						name: 'folderId',
						type: 'number',
						default: 0,
						description: 'Folder ID to create the template in',
					},
					{
						displayName: 'Project ID',
						name: 'projectId',
						type: 'number',
						default: 0,
						description: 'Project ID to create the template in',
					},
				],
			},
			{
				displayName: 'Update Fields',
				name: 'templateUpdateFields',
				type: 'collection',
				default: {},
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['update'],
					},
				},
				options: [
					{
						displayName: 'HTML',
						name: 'html',
						type: 'string',
						typeOptions: { rows: 6 },
						default: '',
						description: 'New HTML content (mutually exclusive with JSON)',
					},
					{
						displayName: 'JSON',
						name: 'json',
						type: 'string',
						typeOptions: { rows: 6 },
						default: '',
						description: 'New Topol JSON content (mutually exclusive with HTML)',
					},
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						description: 'New name for the template',
					},
					{
						displayName: 'Project ID',
						name: 'projectId',
						type: 'number',
						default: 0,
						description: 'Project ID the template lives in',
					},
				],
			},
			{
				displayName: 'Project ID',
				name: 'templateScopeProjectId',
				type: 'number',
				default: 0,
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['get', 'delete', 'getMergeTags', 'getHtml'],
					},
				},
				description: "Project ID. Required for Get HTML. Optional for others (uses team's default project if 0)",
			},
			{
				displayName: 'Version',
				name: 'templateMergeTagsVersion',
				type: 'number',
				default: 0,
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['getMergeTags'],
					},
				},
				description: 'Template version. Defaults to the active version when 0',
			},
			{
				...listOperationProperties[0],
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['getAll'],
					},
				},
			},
			{
				...listOperationProperties[1],
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['getAll'],
						returnAll: [false],
					},
				},
			},
			{
				...listOperationProperties[2],
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['getAll'],
					},
				},
			},
			{
				displayName: 'Project ID',
				name: 'templateProjectId',
				type: 'number',
				default: 0,
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['getAll'],
					},
				},
				description: 'Filter templates by project ID',
			},
			{
				displayName: 'Page',
				name: 'templatePage',
				type: 'number',
				typeOptions: {
					minValue: 1,
				},
				default: 1,
				displayOptions: {
					show: {
						resource: ['template'],
						operation: ['getAll'],
					},
				},
				description: 'Pagination page number',
			},
			{
				displayName: 'Webhook ID',
				name: 'webhookId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['get', 'update', 'delete'],
					},
				},
				description: 'The webhook ID',
			},
			{
				displayName: 'Name',
				name: 'webhookName',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
					},
				},
				description: 'Name of the webhook',
			},
			{
				displayName: 'Target URL',
				name: 'webhookUrl',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com/lettr-events',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
					},
				},
				description: 'URL where webhook events will be sent',
			},
			{
				displayName: 'Auth Type',
				name: 'webhookAuthType',
				type: 'options',
				default: 'none',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
					},
				},
				options: [
					{ name: 'None', value: 'none' },
					{ name: 'Basic', value: 'basic' },
					{ name: 'OAuth2', value: 'oauth2' },
				],
			},
			{
				displayName: 'Auth Username',
				name: 'webhookAuthUsername',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
						webhookAuthType: ['basic'],
					},
				},
			},
			{
				displayName: 'Auth Password',
				name: 'webhookAuthPassword',
				type: 'string',
				typeOptions: { password: true },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
						webhookAuthType: ['basic'],
					},
				},
			},
			{
				displayName: 'OAuth Client ID',
				name: 'webhookOauthClientId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
						webhookAuthType: ['oauth2'],
					},
				},
			},
			{
				displayName: 'OAuth Client Secret',
				name: 'webhookOauthClientSecret',
				type: 'string',
				typeOptions: { password: true },
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
						webhookAuthType: ['oauth2'],
					},
				},
			},
			{
				displayName: 'OAuth Token URL',
				name: 'webhookOauthTokenUrl',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
						webhookAuthType: ['oauth2'],
					},
				},
			},
			{
				displayName: 'Events Mode',
				name: 'webhookEventsMode',
				type: 'options',
				default: 'all',
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
					},
				},
				options: [
					{ name: 'All Events', value: 'all' },
					{ name: 'Selected Events', value: 'selected' },
				],
			},
			{
				displayName: 'Events',
				name: 'webhookEvents',
				type: 'multiOptions',
				default: [],
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['create'],
						webhookEventsMode: ['selected'],
					},
				},
				options: webhookEventOptions,
				description: 'Event types to subscribe to',
			},
			{
				displayName: 'Update Fields',
				name: 'webhookUpdateFields',
				type: 'collection',
				default: {},
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['update'],
					},
				},
				options: [
					{
						displayName: 'Active',
						name: 'active',
						type: 'boolean',
						default: true,
						description: 'Whether the webhook is enabled',
					},
					{
						displayName: 'Auth Password',
						name: 'authPassword',
						type: 'string',
						typeOptions: { password: true },
						default: '',
					},
					{
						displayName: 'Auth Type',
						name: 'authType',
						type: 'options',
						default: 'none',
						options: [
							{ name: 'None', value: 'none' },
							{ name: 'Basic', value: 'basic' },
							{ name: 'OAuth2', value: 'oauth2' },
						],
					},
					{
						displayName: 'Auth Username',
						name: 'authUsername',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Events',
						name: 'events',
						type: 'multiOptions',
						default: [],
						options: webhookEventOptions,
						description: 'Event types to subscribe to',
					},
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
					},
					{
						displayName: 'OAuth Client ID',
						name: 'oauthClientId',
						type: 'string',
						default: '',
					},
					{
						displayName: 'OAuth Client Secret',
						name: 'oauthClientSecret',
						type: 'string',
						typeOptions: { password: true },
						default: '',
					},
					{
						displayName: 'OAuth Token URL',
						name: 'oauthTokenUrl',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Target URL',
						name: 'url',
						type: 'string',
						default: '',
					},
				],
			},
			{
				...listOperationProperties[0],
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['getAll'],
					},
				},
			},
			{
				...listOperationProperties[1],
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['getAll'],
						returnAll: [false],
					},
				},
			},
			{
				...listOperationProperties[2],
				displayOptions: {
					show: {
						resource: ['webhook'],
						operation: ['getAll'],
					},
				},
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getAll',
				displayOptions: {
					show: {
						resource: ['project'],
					},
				},
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get all projects',
						action: 'Get many projects',
					},
				],
			},
			{
				...listOperationProperties[0],
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['getAll'],
					},
				},
			},
			{
				...listOperationProperties[1],
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['getAll'],
						returnAll: [false],
					},
				},
			},
			{
				...listOperationProperties[2],
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['getAll'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;

				if (resource === 'email') {
					if (operation === 'send' || operation === 'schedule') {
						const from = this.getNodeParameter('from', itemIndex) as string;
						const toInput = this.getNodeParameter('to', itemIndex) as string;
						const subject = this.getNodeParameter('subject', itemIndex) as string;
						const html = this.getNodeParameter('html', itemIndex) as string;
						const text = this.getNodeParameter('text', itemIndex) as string;
						const templateSlug = this.getNodeParameter('templateSlug', itemIndex) as string;
						const additionalFields = this.getNodeParameter(
							'additionalFields',
							itemIndex,
							{},
						) as IDataObject;

						if (!html && !text && !templateSlug) {
							throw new NodeOperationError(
								this.getNode(),
								'Provide at least one of: HTML, Text, or Template Slug.',
								{ itemIndex },
							);
						}

						const subjectTrimmed = (subject ?? '').trim();
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
						if (additionalFields.fromName) body.from_name = additionalFields.fromName;
						if (additionalFields.replyTo) body.reply_to = additionalFields.replyTo;
						if (additionalFields.replyToName) body.reply_to_name = additionalFields.replyToName;
						if (additionalFields.ampHtml) body.amp_html = additionalFields.ampHtml;
						if (additionalFields.projectId) body.project_id = additionalFields.projectId;
						if (additionalFields.templateVersion) {
							body.template_version = additionalFields.templateVersion;
						}
						if (additionalFields.campaignId) body.campaign_id = additionalFields.campaignId;

						if (additionalFields.cc) {
							body.cc = splitRecipientList(additionalFields.cc as string);
						}

						if (additionalFields.bcc) {
							body.bcc = splitRecipientList(additionalFields.bcc as string);
						}

						if (additionalFields.metadataJson) {
							body.metadata = parseOptionalJson(
								additionalFields.metadataJson as string,
								'Metadata (JSON)',
								itemIndex,
								this,
							);
						}

						if (additionalFields.substitutionDataJson) {
							body.substitution_data = parseOptionalJson(
								additionalFields.substitutionDataJson as string,
								'Substitution Data (JSON)',
								itemIndex,
								this,
							);
						}

						if (additionalFields.optionsJson) {
							body.options = parseOptionalJson(
								additionalFields.optionsJson as string,
								'Options (JSON)',
								itemIndex,
								this,
							);
						}

						if (additionalFields.attachmentsJson) {
							body.attachments = parseOptionalJson(
								additionalFields.attachmentsJson as string,
								'Attachments (JSON)',
								itemIndex,
								this,
							);
						}

						const endpoint = operation === 'schedule' ? '/emails/scheduled' : '/emails';
						if (operation === 'schedule') {
							const scheduledAt = this.getNodeParameter('scheduledAt', itemIndex) as string;
							if (!scheduledAt) {
								throw new NodeOperationError(
									this.getNode(),
									'"Scheduled At" is required when scheduling an email.',
									{ itemIndex },
								);
							}
							body.scheduled_at = scheduledAt;
						}

						const response = await lettrApiRequest.call(
							this,
							'POST',
							endpoint,
							itemIndex,
							body,
						);

						returnData.push({
							json: response,
							pairedItem: itemIndex,
						});
					}

					if (operation === 'getScheduled' || operation === 'cancelScheduled') {
						const transmissionId = this.getNodeParameter('transmissionId', itemIndex) as string;
						const method: IHttpRequestMethods = operation === 'cancelScheduled' ? 'DELETE' : 'GET';
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

					if (operation === 'getEvents') {
						const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
						const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;
						const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
						const eventTypes = this.getNodeParameter('eventTypes', itemIndex, []) as string[];
						const filters = this.getNodeParameter('eventFilters', itemIndex, {}) as IDataObject;

						const queryBase: IDataObject = {};
						if (eventTypes.length > 0) queryBase.events = eventTypes.join(',');
						if (filters.recipients) queryBase.recipients = filters.recipients;
						if (filters.fromDate) queryBase.from = filters.fromDate;
						if (filters.toDate) queryBase.to = filters.toDate;
						if (filters.transmissionId) queryBase.transmissions = filters.transmissionId;
						if (filters.bounceClasses) queryBase.bounce_classes = filters.bounceClasses;

						const extractEvents = (response: IDataObject): {
							list: IDataObject[];
							nextCursor?: string;
						} => {
							const data = getResponseData(response);
							const eventsContainer = (data.events as IDataObject) ?? {};
							const list = Array.isArray(eventsContainer.data)
								? (eventsContainer.data as IDataObject[])
								: [];
							const pagination = (eventsContainer.pagination as IDataObject) ?? {};
							return {
								list,
								nextCursor: (pagination.next_cursor as string | undefined) ?? undefined,
							};
						};

						if (!returnAll) {
							const qs: IDataObject = {
								...queryBase,
								per_page: limit,
							};

							const response = await lettrApiRequest.call(
								this,
								'GET',
								'/emails/events',
								itemIndex,
								{},
								qs,
							);

							if (!simplify) {
								returnData.push({ json: response, pairedItem: itemIndex });
							} else {
								const { list } = extractEvents(response);
								for (const entry of list) {
									returnData.push({ json: entry, pairedItem: itemIndex });
								}
							}
						} else {
							const entries: IDataObject[] = [];
							let cursor: string | undefined;

							do {
								const qs: IDataObject = {
									...queryBase,
									per_page: 100,
								};
								if (cursor) qs.cursor = cursor;

								const response = await lettrApiRequest.call(
									this,
									'GET',
									'/emails/events',
									itemIndex,
									{},
									qs,
								);

								const { list, nextCursor } = extractEvents(response);
								entries.push(...list);
								cursor = nextCursor;
							} while (cursor);

							if (!simplify) {
								returnData.push({
									json: { data: { events: { data: entries } } },
									pairedItem: itemIndex,
								});
							} else {
								for (const entry of entries) {
									returnData.push({ json: entry, pairedItem: itemIndex });
								}
							}
						}
					}

					if (operation === 'get') {
						const requestId = this.getNodeParameter('requestId', itemIndex) as string;
						const response = await lettrApiRequest.call(
							this,
							'GET',
							`/emails/${requestId}`,
							itemIndex,
						);

						returnData.push({
							json: response,
							pairedItem: itemIndex,
						});
					}

					if (operation === 'getAll') {
						const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
						const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;
						const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
						const recipients = this.getNodeParameter('recipients', itemIndex, '') as string;
						const fromDate = this.getNodeParameter('fromDate', itemIndex, '') as string;
						const toDate = this.getNodeParameter('toDate', itemIndex, '') as string;
						const startingCursor = this.getNodeParameter('cursor', itemIndex, '') as string;

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
								'GET',
								'/emails',
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
								const list = getResponseList(response, 'emails');
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
									'GET',
									'/emails',
									itemIndex,
									{},
									qs,
								);

								entries.push(...getResponseList(response, 'emails'));
								const pagination = getPagination(response);
								cursor = (pagination.next_cursor as string | undefined) ?? undefined;
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

				if (resource === 'domain' && operation === 'create') {
					const domain = this.getNodeParameter('domain', itemIndex) as string;
					const response = await lettrApiRequest.call(
						this,
						'POST',
						'/domains',
						itemIndex,
						{ domain },
					);

					returnData.push({ json: response, pairedItem: itemIndex });
				}

				if (
					resource === 'domain' &&
					(operation === 'get' || operation === 'delete' || operation === 'verify')
				) {
					const domain = this.getNodeParameter('domain', itemIndex) as string;
					const method: IHttpRequestMethods =
						operation === 'delete' ? 'DELETE' : operation === 'verify' ? 'POST' : 'GET';
					const endpoint =
						operation === 'verify' ? `/domains/${domain}/verify` : `/domains/${domain}`;

					const response = await lettrApiRequest.call(this, method, endpoint, itemIndex);
					returnData.push({ json: response, pairedItem: itemIndex });
				}

				if (resource === 'domain' && operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
					const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
					const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;
					const response = await lettrApiRequest.call(this, 'GET', '/domains', itemIndex);
					const list = getResponseList(response, 'domains');
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

				if (resource === 'template' && operation === 'create') {
					const name = this.getNodeParameter('templateName', itemIndex) as string;
					const contentType = this.getNodeParameter(
						'templateContentType',
						itemIndex,
					) as string;
					const additional = this.getNodeParameter(
						'templateCreateFields',
						itemIndex,
						{},
					) as IDataObject;

					const body: IDataObject = { name };
					if (contentType === 'html') {
						body.html = this.getNodeParameter('templateHtml', itemIndex) as string;
					} else {
						body.json = this.getNodeParameter('templateJson', itemIndex) as string;
					}
					if (additional.projectId) body.project_id = additional.projectId;
					if (additional.folderId) body.folder_id = additional.folderId;

					const response = await lettrApiRequest.call(
						this,
						'POST',
						'/templates',
						itemIndex,
						body,
					);
					returnData.push({ json: response, pairedItem: itemIndex });
				}

				if (resource === 'template' && operation === 'update') {
					const slug = this.getNodeParameter('templateSlugParam', itemIndex) as string;
					const fields = this.getNodeParameter(
						'templateUpdateFields',
						itemIndex,
						{},
					) as IDataObject;

					if (fields.html && fields.json) {
						throw new NodeOperationError(
							this.getNode(),
							'Provide either HTML or JSON, not both.',
							{ itemIndex },
						);
					}

					const body: IDataObject = {};
					if (fields.name) body.name = fields.name;
					if (fields.html) body.html = fields.html;
					if (fields.json) body.json = fields.json;
					if (fields.projectId) body.project_id = fields.projectId;

					const hasChange = body.name !== undefined || body.html !== undefined || body.json !== undefined;
					if (!hasChange) {
						throw new NodeOperationError(
							this.getNode(),
							'Provide Name, HTML, or JSON to update the template.',
							{ itemIndex },
						);
					}

					const response = await lettrApiRequest.call(
						this,
						'PUT',
						`/templates/${slug}`,
						itemIndex,
						body,
					);
					returnData.push({ json: response, pairedItem: itemIndex });
				}

				if (
					resource === 'template' &&
					(operation === 'get' || operation === 'delete' || operation === 'getMergeTags')
				) {
					const slug = this.getNodeParameter('templateSlugParam', itemIndex) as string;
					const projectId = this.getNodeParameter(
						'templateScopeProjectId',
						itemIndex,
						0,
					) as number;

					const qs: IDataObject = {};
					if (projectId > 0) qs.project_id = projectId;

					if (operation === 'getMergeTags') {
						const version = this.getNodeParameter(
							'templateMergeTagsVersion',
							itemIndex,
							0,
						) as number;
						if (version > 0) qs.version = version;
					}

					const method: IHttpRequestMethods = operation === 'delete' ? 'DELETE' : 'GET';
					const endpoint =
						operation === 'getMergeTags'
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

				if (resource === 'template' && operation === 'getHtml') {
					const slug = this.getNodeParameter('templateSlugParam', itemIndex) as string;
					const projectId = this.getNodeParameter(
						'templateScopeProjectId',
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
						'GET',
						'/templates/html',
						itemIndex,
						{},
						{ slug, project_id: projectId },
					);
					returnData.push({ json: response, pairedItem: itemIndex });
				}

				if (resource === 'template' && operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
					const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
					const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;
					const projectId = this.getNodeParameter('templateProjectId', itemIndex, 0) as number;
					const startingPage = this.getNodeParameter('templatePage', itemIndex, 1) as number;

					const queryBase: IDataObject = {};
					if (projectId > 0) queryBase.project_id = projectId;

					if (!returnAll) {
						const qs: IDataObject = {
							...queryBase,
							per_page: limit,
							page: startingPage,
						};

						const response = await lettrApiRequest.call(
							this,
							'GET',
							'/templates',
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
							const list = getResponseList(response, 'templates');
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
								'GET',
								'/templates',
								itemIndex,
								{},
								qs,
							);

							entries.push(...getResponseList(response, 'templates'));
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

				if (resource === 'webhook' && operation === 'create') {
					const name = this.getNodeParameter('webhookName', itemIndex) as string;
					const url = this.getNodeParameter('webhookUrl', itemIndex) as string;
					const authType = this.getNodeParameter('webhookAuthType', itemIndex) as string;
					const eventsMode = this.getNodeParameter('webhookEventsMode', itemIndex) as string;

					const body: IDataObject = {
						name,
						url,
						auth_type: authType,
						events_mode: eventsMode,
					};

					if (authType === 'basic') {
						const authUsername = this.getNodeParameter(
							'webhookAuthUsername',
							itemIndex,
							'',
						) as string;
						const authPassword = this.getNodeParameter(
							'webhookAuthPassword',
							itemIndex,
							'',
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

					if (authType === 'oauth2') {
						const clientId = this.getNodeParameter(
							'webhookOauthClientId',
							itemIndex,
							'',
						) as string;
						const clientSecret = this.getNodeParameter(
							'webhookOauthClientSecret',
							itemIndex,
							'',
						) as string;
						const tokenUrl = this.getNodeParameter(
							'webhookOauthTokenUrl',
							itemIndex,
							'',
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

					if (eventsMode === 'selected') {
						const events = this.getNodeParameter('webhookEvents', itemIndex, []) as string[];
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
						'POST',
						'/webhooks',
						itemIndex,
						body,
					);
					returnData.push({ json: response, pairedItem: itemIndex });
				}

				if (
					resource === 'webhook' &&
					(operation === 'get' || operation === 'delete')
				) {
					const webhookId = this.getNodeParameter('webhookId', itemIndex) as string;
					const method: IHttpRequestMethods = operation === 'delete' ? 'DELETE' : 'GET';
					const response = await lettrApiRequest.call(
						this,
						method,
						`/webhooks/${webhookId}`,
						itemIndex,
					);
					returnData.push({ json: response, pairedItem: itemIndex });
				}

				if (resource === 'webhook' && operation === 'update') {
					const webhookId = this.getNodeParameter('webhookId', itemIndex) as string;
					const fields = this.getNodeParameter(
						'webhookUpdateFields',
						itemIndex,
						{},
					) as IDataObject;

					const body: IDataObject = {};
					if (fields.name !== undefined && fields.name !== '') body.name = fields.name;
					if (fields.url !== undefined && fields.url !== '') body.url = fields.url;
					if (fields.authType !== undefined) body.auth_type = fields.authType;
					if (fields.authUsername !== undefined && fields.authUsername !== '') {
						body.auth_username = fields.authUsername;
					}
					if (fields.authPassword !== undefined && fields.authPassword !== '') {
						body.auth_password = fields.authPassword;
					}
					if (fields.oauthClientId !== undefined && fields.oauthClientId !== '') {
						body.oauth_client_id = fields.oauthClientId;
					}
					if (fields.oauthClientSecret !== undefined && fields.oauthClientSecret !== '') {
						body.oauth_client_secret = fields.oauthClientSecret;
					}
					if (fields.oauthTokenUrl !== undefined && fields.oauthTokenUrl !== '') {
						body.oauth_token_url = fields.oauthTokenUrl;
					}
					if (Array.isArray(fields.events) && (fields.events as unknown[]).length > 0) {
						body.events = fields.events;
					}
					if (fields.active !== undefined) body.active = fields.active;

					if (Object.keys(body).length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'Provide at least one field to update.',
							{ itemIndex },
						);
					}

					const response = await lettrApiRequest.call(
						this,
						'PUT',
						`/webhooks/${webhookId}`,
						itemIndex,
						body,
					);
					returnData.push({ json: response, pairedItem: itemIndex });
				}

				if (resource === 'webhook' && operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
					const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
					const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;
					const response = await lettrApiRequest.call(this, 'GET', '/webhooks', itemIndex);
					const list = getResponseList(response, 'webhooks');
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

				if (resource === 'project' && operation === 'getAll') {
					const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
					const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
					const simplify = this.getNodeParameter('simplify', itemIndex, true) as boolean;

					if (!returnAll) {
						const qs: IDataObject = { per_page: limit, page: 1 };
						const response = await lettrApiRequest.call(
							this,
							'GET',
							'/projects',
							itemIndex,
							{},
							qs,
						);

						if (!simplify) {
							returnData.push({ json: response, pairedItem: itemIndex });
						} else {
							for (const entry of getResponseList(response, 'projects')) {
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
								'GET',
								'/projects',
								itemIndex,
								{},
								qs,
							);
							entries.push(...getResponseList(response, 'projects'));
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
			} catch (error) {
				if (this.continueOnFail()) {
					const message = error instanceof Error ? error.message : 'Unknown error';
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
