/*****************************************************************************\
|                                               ( )_  _                       |
|    _ _    _ __   _ _    __    ___ ___     _ _ | ,_)(_)  ___   ___     _     |
|   ( '_`\ ( '__)/'_` ) /'_ `\/' _ ` _ `\ /'_` )| |  | |/',__)/' _ `\ /'_`\   |
|   | (_) )| |  ( (_| |( (_) || ( ) ( ) |( (_| || |_ | |\__, \| (˅) |( (_) )  |
|   | ,__/'(_)  `\__,_)`\__  |(_) (_) (_)`\__,_)`\__)(_)(____/(_) (_)`\___/'  |
|   | |                ( )_) |                                                |
|   (_)                 \___/'                                                |
|                                                                             |
| General Bots Copyright (c) Pragmatismo.io. All rights reserved.             |
| Licensed under the AGPL-3.0.                                                |
|                                                                             |
| According to our dual licensing model, this program can be used either      |
| under the terms of the GNU Affero General Public License, version 3,        |
| or under a proprietary license.                                             |
|                                                                             |
| The texts of the GNU Affero General Public License with an additional       |
| permission and of our proprietary license can be found at and               |
| in the LICENSE file you have received along with this program.              |
|                                                                             |
| This program is distributed in the hope that it will be useful,             |
| but WITHOUT ANY WARRANTY, without even the implied warranty of              |
| MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the                |
| GNU Affero General Public License for more details.                         |
|                                                                             |
| "General Bots" is a registered trademark of Pragmatismo.io.                 |
| The licensing of the program under the AGPLv3 does not imply a              |
| trademark license. Therefore any rights, title and interest in              |
| our trademarks remain entirely with us.                                     |
|                                                                             |
\*****************************************************************************/

/**
 * @fileoverview General Bots server core.
 */

'use strict';

import { BotAdapter } from 'botbuilder';
import { WaterfallDialog } from 'botbuilder-dialogs';
import { GBLog, GBMinInstance, IGBDialog } from 'botlib';
import { AzureText } from 'pragmatismo-io-framework';
import { Messages } from '../strings';
import { KBService } from './../services/KBService';

/**
 * Dialog arguments.
 */
export class AskDialogArgs {
  public questionId: number;
  public fromFaq: boolean;
}

/**
 * Handle the ask loop on knowledge base data or delegate to other services.
 */
export class AskDialog extends IGBDialog {
  /**
   * Setup dialogs flows and define services call.
   *
   * @param bot The bot adapter.
   * @param min The minimal bot instance data.
   */
  public static setup(bot: BotAdapter, min: GBMinInstance) {
    const service = new KBService(min.core.sequelize);
    min.dialogs.add(new WaterfallDialog('/answerEvent', AskDialog.getAnswerEventDialog(service, min)));
    min.dialogs.add(new WaterfallDialog('/answer', AskDialog.getAnswerDialog(min, service)));
    min.dialogs.add(new WaterfallDialog('/ask', AskDialog.getAskDialog(min)));



  }

  private static getAskDialog(min: GBMinInstance) {
    return [
      async step => {
        const locale = step.context.activity.locale;
        const user = await min.userProfile.get(step.context, {});
        user.isAsking = true;
        if (!user.subjects) {
          user.subjects = [];
        }
        let text;
        // Three forms of asking.
        if (step.options && step.options.firstTime) {
          text = Messages[locale].ask_first_time;
        } else if (step.options && step.options.isReturning) {
          text = Messages[locale].anything_else;
        } else if (user.subjects.length > 0) {
          text = Messages[locale].which_question;
        } else {
          throw new Error('Invalid use of /ask');
        }
        if (text.length > 0) {
          return await step.prompt('textPrompt', text);
        }

        return await step.next();
      },
      async step => {
        if (step.result) {
          return await step.replaceDialog('/answer', { query: step.result });
        } else {
          return await step.next();
        }
      }
    ];
  }

  private static getAnswerDialog(min: GBMinInstance, service: KBService) {
    return [
      async step => {
        const user = await min.userProfile.get(step.context, {});
        let text = step.options.query;
        if (!text) {
          throw new Error(`/answer being called with no args query text.`);
        }
        const locale = step.context.activity.locale;
        // Stops any content on projector.
        await min.conversationalService.sendEvent(step, 'stop', undefined);
        // Handle extra text from FAQ.
        if (step.options && step.options.query) {
          text = step.options.query;
        } else if (step.options && step.options.fromFaq) {
          await step.context.sendActivity(Messages[locale].going_answer);
        }
        // Spells check the input text before sending Search or NLP.
        if (min.instance.spellcheckerKey !== undefined) {
          const data = await AzureText.getSpelledText(min.instance.spellcheckerKey, text);
          if (data !== text) {
            GBLog.info(`Spelling corrected: ${data}`);
            text = data;
          }
        }

        // Searches KB for the first time.
        user.lastQuestion = text;
        await min.userProfile.set(step.context, user);
        const resultsA = await service.ask(min.instance, text, min.instance.searchScore, user.subjects);

        // If there is some result, answer immediately.
        if (resultsA !== undefined && resultsA.answer !== undefined) {
          // Saves some context info.
          user.isAsking = false;
          user.lastQuestionId = resultsA.questionId;
          await min.userProfile.set(step.context, user);

          // Sends the answer to all outputs, including projector.
          await service.sendAnswer(min.conversationalService, step, resultsA.answer);

          // Goes to ask loop, again.
          return await step.replaceDialog('/ask', { isReturning: true });
        } else {
          // Second time running Search, now with no filter.
          const resultsB = await service.ask(min.instance, text, min.instance.searchScore, undefined);
          // If there is some result, answer immediately.

          if (resultsB !== undefined && resultsB.answer !== undefined) {
            // Saves some context info.
            const user2 = await min.userProfile.get(step.context, {});
            user2.isAsking = false;
            user2.lastQuestionId = resultsB.questionId;
            await min.userProfile.set(step.context, user2);
            // Informs user that a broader search will be used.
            if (user2.subjects.length > 0) {
              await step.context.sendActivity(Messages[locale].wider_answer);
            }
            // Sends the answer to all outputs, including projector.
            await service.sendAnswer(min.conversationalService, step, resultsB.answer);

            return await step.replaceDialog('/ask', { isReturning: true });
          } else {
            if (!(await min.conversationalService.routeNLP(step, min, text))) {
              await step.context.sendActivity(Messages[locale].did_not_find);

              return await step.replaceDialog('/ask', { isReturning: true });
            }
          }
        }
      }
    ];
  }

  private static getAnswerEventDialog(service: KBService, min: GBMinInstance) {
    return [
      async step => {
        const data = step.options as AskDialogArgs;
        if (data !== undefined && data.questionId !== undefined) {
          const question = await service.getQuestionById(min.instance.instanceId, data.questionId);
          const answer = await service.getAnswerById(min.instance.instanceId, question.answerId);
          // Sends the answer to all outputs, including projector.
          await service.sendAnswer(min.conversationalService, step, answer);
          await step.replaceDialog('/ask', { isReturning: true });
        }

        return await step.next();
      }
    ];
  }
}
