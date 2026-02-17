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
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
	}
}

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
						name: 'Get',
						value: 'get',
						description: 'Get an email request by ID',
						action: 'Get an email request',
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
						name: 'Get Many',
						value: 'getAll',
						description: 'Get all sending domains',
						action: 'Get many domains',
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
						name: 'Get Many',
						value: 'getAll',
						description: 'Get all templates',
						action: 'Get many templates',
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
						name: 'Get Many',
						value: 'getAll',
						description: 'Get all webhooks',
						action: 'Get many webhooks',
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
						operation: ['send'],
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
						operation: ['send'],
					},
				},
				description: 'Recipient email addresses (comma, semicolon, or newline separated)',
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['send'],
					},
				},
				description: 'Email subject line',
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
						operation: ['send'],
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
						operation: ['send'],
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
						operation: ['send'],
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
						operation: ['send'],
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
					if (operation === 'send') {
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
							subject,
						};

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

						const response = await lettrApiRequest.call(
							this,
							'POST',
							'/emails',
							itemIndex,
							body,
						);

						returnData.push({
							json: response,
							pairedItem: itemIndex,
						});
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
