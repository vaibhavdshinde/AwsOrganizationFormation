import { CreateStackInput, DeleteStackInput, UpdateStackInput } from 'aws-sdk/clients/cloudformation';
import uuid = require('uuid');
import { AwsUtil } from '../util/aws-util';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../../src/org-formation-error';
import { ICfnBinding } from './cfn-binder';
import { PersistedState } from '~state/persisted-state';
import { ICfnExpression } from '~core/cfn-expression';
import { CfnExpressionResolver } from '~core/cfn-expression-resolver';
import { TemplateRoot } from '~parser/parser';

export class CfnTaskProvider {
    constructor(private readonly template: TemplateRoot, private readonly state: PersistedState) {

    }

    public createUpdateTemplateTask(binding: ICfnBinding): ICfnTask {
        const that = this;
        const dependencies: ICrossAccountParameterDependency[] = [];
        const boundParameters = binding.template.enumBoundParameters();
        for (const paramName in boundParameters) {
            const param = boundParameters[paramName];
            const dependency: ICrossAccountParameterDependency = {
                ExportAccountId: binding.accountId,
                ExportRegion: binding.region,
                ExportName: param.ExportName,
                ParameterKey: paramName,
            };
            if (param.ExportAccountId) { dependency.ExportAccountId = param.ExportAccountId; }
            if (param.ExportRegion) { dependency.ExportRegion = param.ExportRegion; }
            dependencies.push(dependency);

            delete param.ExportAccountId;
            delete param.ExportName;
            delete param.ExportRegion;
        }

        const parameters: Record<string,ICfnExpression> = {};
        for(const [paramName, paramValue] of Object.entries(binding.parameters)) {
            parameters[paramName] = paramValue;
        }


        return {
            accountId: binding.accountId,
            region: binding.region,
            stackName: binding.stackName,
            action: 'UpdateOrCreate',
            isDependency: (): boolean => false,
            perform: async (): Promise<void> => {

                const templateBody = binding.template.createTemplateBody();
                const cfn = await AwsUtil.GetCloudFormation(binding.accountId, binding.region, binding.customRoleName);
                const clientToken = uuid();

                let roleArn: string;
                if (binding.cloudFormationRoleName) {
                    roleArn = AwsUtil.GetRoleArn(binding.accountId, binding.cloudFormationRoleName);
                }
                const stackInput: CreateStackInput | UpdateStackInput = {
                    StackName: binding.stackName,
                    TemplateBody: templateBody,
                    Capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_IAM'],
                    ClientRequestToken: clientToken,
                    RoleARN: roleArn,
                    Parameters: [],
                };

                if (binding.stackPolicy !== undefined) {
                    stackInput.StackPolicyBody = JSON.stringify(binding.stackPolicy);
                }

                for (const dependency of dependencies) {

                    const foundExport = await AwsUtil.GetCloudFormationExport(dependency.ExportName, dependency.ExportAccountId, dependency.ExportRegion, binding.customRoleName);

                    if (foundExport !== undefined) {
                        stackInput.Parameters.push( {
                            ParameterKey: dependency.ParameterKey,
                            ParameterValue: foundExport,
                        });
                    } else {
                        // this is somewhat lame, but is here to support cross account references where the dependency has a condition.
                        // the dependency and dependent both have conditions
                        // the generated export has a condition
                        // the parameter used in the template of dependent cannot have a condition.
                        //  so we use an empty value instead :(
                        stackInput.Parameters.push( {
                            ParameterKey: dependency.ParameterKey,
                            ParameterValue: '',
                        });
                    }
                }

                if (parameters) {
                    const expressionResolver = CfnExpressionResolver.CreateDefaultResolver(binding.accountLogicalId, binding.accountId, binding.region, binding.customRoleName, this.template, this.state);

                    for (const [key, value] of Object.entries(parameters)) {

                        let paramValue = value;
                        if (typeof paramValue === 'object') {
                            paramValue = await expressionResolver.resolve(paramValue);
                            paramValue = await expressionResolver.collapse(paramValue);
                        }

                        if (typeof paramValue === 'object') {
                            if (Array.isArray(paramValue)) {
                                paramValue = paramValue.join(', ');
                            } else {
                                throw new OrgFormationError(`unable to fully resolve expression ${JSON.stringify(paramValue)}`);
                            }
                        } else if (typeof paramValue === 'undefined') {
                            paramValue = '';
                        }

                        stackInput.Parameters.push( {
                            ParameterKey: key,
                            ParameterValue: '' + paramValue as string,
                        });
                    }
                }
                try {
                    try {
                        await cfn.updateStack(stackInput).promise();
                        await cfn.waitFor('stackUpdateComplete', { StackName: binding.stackName, $waiter: { delay: 1, maxAttempts: 60 * 30 } }).promise();
                    } catch (err) {
                        if (err && err.code === 'ValidationError' && err.message) {
                            const message = err.message as string;
                            if (-1 !== message.indexOf('ROLLBACK_COMPLETE')) {
                                await cfn.deleteStack({ StackName: binding.stackName, RoleARN: roleArn }).promise();
                                await cfn.waitFor('stackDeleteComplete', { StackName: binding.stackName, $waiter: { delay: 1 } }).promise();
                                await cfn.createStack(stackInput).promise();
                                await cfn.waitFor('stackCreateComplete', { StackName: binding.stackName, $waiter: { delay: 1, maxAttempts: 60 * 30 } }).promise();
                            } else if (-1 !== message.indexOf('does not exist')) {
                                await cfn.createStack(stackInput).promise();
                                await cfn.waitFor('stackCreateComplete', { StackName: binding.stackName, $waiter: { delay: 1, maxAttempts: 60 * 30 } }).promise();
                            } else if (-1 !== message.indexOf('No updates are to be performed.')) {
                                // ignore;
                            } else if (err.code === 'ResourceNotReady') {
                                ConsoleUtil.LogError('error when executing CloudFormation');
                            } else {
                                throw err;
                            }
                        } else {
                            throw err;
                        }
                    }

                    if (binding.state === undefined && binding.terminationProtection === true) {
                        ConsoleUtil.LogDebug(`Enabling termination protection for stack ${binding.stackName}`);
                        await cfn.updateTerminationProtection({StackName: binding.stackName, EnableTerminationProtection: true}).promise();
                    } else if (binding.state !== undefined) {
                        if (binding.terminationProtection) {
                            if (!binding.state.terminationProtection) {
                                ConsoleUtil.LogDebug(`Enabling termination protection for stack ${binding.stackName}`);
                                await cfn.updateTerminationProtection({StackName: binding.stackName, EnableTerminationProtection: true}).promise();
                            }
                        } else {
                            if (binding.state.terminationProtection) {
                                ConsoleUtil.LogDebug(`Disabling termination protection for stack ${binding.stackName}`);
                                await cfn.updateTerminationProtection({StackName: binding.stackName, EnableTerminationProtection: false}).promise();
                            }
                        }
                    }

                    that.state.setTarget({
                        accountId: binding.accountId,
                        region: binding.region,
                        stackName: binding.stackName,
                        lastCommittedHash: binding.templateHash,
                        logicalAccountId: binding.target.accountLogicalId,
                        terminationProtection: binding.terminationProtection,
                    });
                } catch (err) {
                    if (err.code !== 'OptInRequired') {
                        ConsoleUtil.LogError(`error updating CloudFormation stack ${binding.stackName} in account ${binding.accountId} (${binding.region}). \n${err.message}`);
                    }
                    try {
                        const stackEvents = await cfn.describeStackEvents({ StackName: binding.stackName }).promise();
                        for (const event of stackEvents.StackEvents) {
                            const failureStates = ['CREATE_FAILED', 'DELETE_FAILED', 'UPDATE_FAILED'];
                            if (event.ClientRequestToken === clientToken) {
                                if (failureStates.indexOf(event.ResourceStatus) >= 0) {
                                    ConsoleUtil.LogError(`Resource ${event.LogicalResourceId} failed because ${event.ResourceStatusReason}.`);

                                    if (/[0-9a-f]*\|[0-9]{12} already exists in stack /.test(event.ResourceStatusReason)) {
                                        ConsoleUtil.LogError('!!! It seems like you got this error when updating GuardDuty resources.');
                                        ConsoleUtil.LogError('!!! Possibly your first change to GuardDuty since upgrading to org-formation to 0.0.70+ or you renamed a logical account id.');
                                        ConsoleUtil.LogError('!!! You can resolve this error by commenting out both Master and Member resources and updating the stack');
                                        ConsoleUtil.LogError('!!! After updating the stacks without these resources uncomment first the Member resource them back, run update, then also the Master resource.');
                                        ConsoleUtil.LogError('!!! hopefully that will fix this. Sorry for the inconvenience!! <3 from org-formation.');
                                    }
                                }
                            }
                        }
                    } catch {/* hide*/ }

                    throw err;
                }
            },
        };
    }

    public createDeleteTemplateTask(binding: ICfnBinding): ICfnTask {
        const that = this;
        return {
            accountId: binding.accountId,
            region: binding.region,
            stackName: binding.stackName,
            isDependency: (): boolean => false,
            action: 'Delete',
            perform: async (): Promise<void> => {
                try {
                    const cfn = await AwsUtil.GetCloudFormation(binding.accountId, binding.region, binding.customRoleName);

                    let roleArn: string;
                    if (binding.cloudFormationRoleName) {
                        roleArn = AwsUtil.GetRoleArn(binding.accountId, binding.cloudFormationRoleName);
                    }

                    const deleteStackInput: DeleteStackInput = {
                        StackName: binding.stackName,
                        RoleARN: roleArn,
                    };
                    await cfn.deleteStack(deleteStackInput).promise();
                    await cfn.waitFor('stackDeleteComplete', { StackName: deleteStackInput.StackName, $waiter: { delay: 1, maxAttempts: 60 * 30 } }).promise();
                } catch (err) {
                    ConsoleUtil.LogInfo(`unable to delete stack ${binding.stackName} from ${binding.accountId} / ${binding.region}. Removing stack from state instead.`);
                }
                that.state.removeTarget(
                    binding.stackName,
                    binding.accountId,
                    binding.region);
            },
        };
    }

}

interface ICrossAccountParameterDependency {
    ExportAccountId: string;
    ExportRegion: string;
    ExportName: string;
    ParameterKey: string;
}

export interface ICfnTask {
    action: CfnBuildTaskAction;
    accountId: string;
    region: string;
    stackName: string;
    perform: () => Promise<void>;
    isDependency: (task: ICfnTask) => boolean;
    skip?: boolean;
}
type CfnBuildTaskAction = 'UpdateOrCreate' | 'Delete' | 'Validate';
