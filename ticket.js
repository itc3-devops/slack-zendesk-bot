"use latest";
var request = require('request');
var moment = require('moment');
var util = require('util');

var zendeskRootUrl = 'https://auth0.zendesk.com/api/v2/';
var slackRootUrl = 'https://slack.com/api/';

var slackUsersById = new Map();
var slackUsersByName = new Map();

return function(context, req, res) {

  function getSlackUser(userId) {
    return new Promise((resolve, reject) => {
      // Check cache
      if (slackUsersById.has(userId)) {
        return resolve(slackUsersById.get(userId));
      }

      request({
        url: slackRootUrl + 'users.info?token=' + context.data.slack_api_token + '&user=' + user_id,
        method: 'GET'
      }, function(err, response, body) {
        if (err || response.statusCode !== 200) {
          console.error('slack/users.info: ' + JSON.stringify(body));
          return reject(err || 'Status code: ' + response.statusCode);
        }
        var result = JSON.parse(body);
        slackUsersById.set(userId, result);
        return resolve(result);
      });
    });
  }

  function getSlackUserByName(username) {
    return new Promise((resolve, reject) => {

      // Check cache
      if (slackUsersByName.has(username)) {
        return resolve(slackUsersByName.get(username));
      }

      request({
        url: slackRootUrl + 'users.list?token=' + context.data.slack_api_token,
        method: 'GET'
      }, function(err, response, body) {
        if (err || response.statusCode !== 200) {
          console.error('slack/users.list: ' + JSON.stringify(body));
          return reject(err || 'Status code: ' + response.statusCode);
        }
        var result = JSON.parse(body);
        for (var i = 0; i < result.members.length; i++) {
          var user = result.members[i];
          slackUsersById.set(user.id, user);
          slackUsersByName.set(user.name, user);
        }

        if (slackUsersByName.has(username)) {
          return resolve(slackUsersByName.get(username));
        } else {
          return reject('Could not find slack user.');
        }
      });
    });
  }

  function getSlackMessages(channelId, oldestTime) {
    return new Promise((resolve, reject) => {
      request({
        url: util.format('%schannels.history?token=%s&channel=%s&oldest=%s', slackRootUrl, context.data.slack_api_token, channelId, oldestTime),
        method: 'GET'
      }, function(err, response, body) {
        if (err || response.statusCode !== 200) {
          console.error('slack/channels.history: ' + JSON.stringify(body));
          return reject(err || 'Status code: ' + response.statusCode);
        }
        var result = JSON.parse(body);
        return resolve(result);
      });
    });
  }

  function postSupportTicket(ticket) {
    return new Promise((resolve, reject) => {
      var token = new Buffer(context.data.zendesk_api_email + '/token:' + context.data.zendesk_api_token).toString('base64');
      request({
        url: zendeskRootUrl + 'tickets.json',
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + token
        },
        json: { ticket: ticket }
      }, function(err, response, body) {
        if (err || response.statusCode !== 201) {
          console.error('zendesk/postticket: ' + JSON.stringify(body));
          return reject(err || 'Status code: ' + response.statusCode);
        }
        resolve(body);
      });
    });
  }

  function postSlackMessage(channelId, text, username, iconUrl) {
    return new Promise((resolve, reject) => {
      request({
        url: util.format('%schat.postMessage?token=%s&channel=%s&text=%s&username=%s&icon_url=%s', slackRootUrl, context.data.slack_api_token, channelId, text, username, iconUrl),
        method: 'POST',
      }, function(err, response, body) {
        if (err || response.statusCode !== 200) {
          console.error('slack/chat.postMessage: ' + JSON.stringify(body));
          return reject(err || 'Status code: ' + response.statusCode);
        }
        return resolve(body);
      });
    });
  }

  function buildTicketBody(messages, user) {

    var p = [];
    var startsWith1 = '<' + user.name;
    var startsWith2 = '<@' + user.id;
    for (var i = messages.length - 1; i >= 0; i--) {
      var message = messages[i];
      if (message.subtype !== 'bot_message' && message.subtype !== 'channel_join') {
        if (message.user === user.id) {
          p.push('@' + user.name + ': ' + message.text);
        } else if ((message.text.indexOf(startsWith1) === 0 || message.text.indexOf(startsWith2) === 0)) {
          p.push(Promise.resolve(message).then(message => {
            return getSlackUser(message.user)
            .then(resultUser => {
              return '@' + resultUser.name + ': ' + message.text.substring(message.text.indexOf('>: ') + 2);
            });
          }));
        }
      }
    }

    return Promise.all(p)
    .then(values => {
      var body = values.join('\n');
      return body.replace(user.id, user.name).replace('<@' + user.name + '>', '@' + user.name);
    });
  }

  function openTicket(commandData) {

    if (commandData.token !== context.data.slack_command_token) {
      return Promise.reject('Invalid token');
    }

    var slackCustomerUser;
    var space = commandData.text.indexOf(' ');
    if (space > 0) {
      slackCustomerUser = commandData.text.substring(0, space);
    } else {
      slackCustomerUser = commandData.text.trim();
    }

    if (!slackCustomerUser || slackCustomerUser.indexOf('@') !== 0) {
      return Promise.reject('Cannot open ticket. User was not provided.');
    }

    var commandText = commandData.text.replace(slackCustomerUser, '').trim();

    return getSlackUserByName(slackCustomerUser.substring(1))
    .then(user => {
      var oldest = moment().subtract(1, 'hour').format('X');
      return getSlackMessages(commandData.channel_id, oldest)
      .then(function(messageResult) {
        return buildTicketBody(messageResult.messages, user);
      })
      .then(function(body) {

        var subject;
        if (commandText.length > 0 && body) {
          // If the command text is provided and there is a body, the text is used as the subject.
          subject = commandText;
        } else if (commandText.length === 0 && body) {
          // If command text is not provide, but we have a body then generate a default subject.
          subject = 'Slack chat with ' + slackCustomerUser;
        } else if (commandText.length > 0 && !body) {
          // If command text is provided, but no body then use generic subject and text as body.
          subject = 'Slack chat with ' + slackCustomerUser;
          body = commandText;
        } else {
          // If no command text and no body, there is an error
          return Promise.reject('No recent comments found for ' + slackCustomerUser + '. You must provide the issue text.');
        }

        return Promise.resolve({
          requester: {
            name:       user.profile.real_name,
            email:      user.profile.email
          },
          subject:      subject,
          comment: {
            body:       body
          }
        });
      });
    })
    .then(postSupportTicket)
    .then(ticket => {
      var text = '<' + slackCustomerUser + '> A support ticket (' + ticket.ticket.id + ') has been opened for your request. We contact you through the email address associated with your Slack account as soon as possible.';
      var iconUrl = 'https://www.gravatar.com/avatar/7db6b16c9871854df6e522209e0a0631';
      return postSlackMessage(commandData.channel_id, text, 'support', iconUrl).then(function(result) {
        return Promise.resolve(ticket);
      });
    });
  }

  openTicket(context.data)
  .then(result => {
    var text = 'Ticket created: <https://auth0.zendesk.com/agent/tickets/' + result.ticket.id + '|' + result.ticket.id + '>';
    res.writeHead(200, { 'Content-Type': 'text/plain'});
    res.end(text);
  }).catch(function(err) {
    var message = 'An error has occurred. If you would like to open a support ticket please email support@auth0.com';
    if (typeof err === 'string') {
      message = err;
    }
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain'});
    res.end(message);
  });
};