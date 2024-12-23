const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const bodyParser = require('body-parser');
const { default: axios } = require('axios');
const { JIRA_PROMPT } = require('./lib/config');
const db = require('./lib/database');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const JIRA_API_URL = process.env.JIRA_API_URL;
const JIRA_API_USER = process.env.JIRA_API_USER;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY
const JIRA_PROJECT_NAME = process.env.JIRA_PROJECT_NAME

// Initialize Anthropic client
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

const errorHandler = (err, req, res, next) => {
    if (err.code === '23505') {
        // PostgreSQL duplicate entry error
        return res.status(400).json({ error: 'This email is already on the waitlist.' });
    } else {
        // Generic error
        console.error(err); // Log the actual error for debugging purposes
        return res.status(500).json({ error: 'Internal Server Error, please try again later.' });
    }
}

// Middleware
app.use(bodyParser.json());
app.use(cors());

const get_ticket_details = async (ticketId) => {
    try {
        const response = await axios.get(`${JIRA_API_URL}/rest/api/3/issue/${ticketId}`, {
            params: {
                fields: 'summary,status,assignee,comment' // Specify the fields you want
            },
            headers: {
                // Authorization: `Basic ${Buffer.from(`${JIRA_API_USER}:${JIRA_API_TOKEN}`).toString('base64')}`,
                'Content-Type': 'application/json'
            },
            auth: {
                username: JIRA_API_USER,
                password: JIRA_API_TOKEN,
            },
        });

        const data = response.data;

        // Optionally log or process the ticket data
        console.log(`Ticket ID: ${ticketId}`);
        console.log(`Summary: ${data.fields.summary}`);
        console.log(`Status: ${data.fields.status.name}`);
        console.log(`Assignee: ${data.fields.assignee ? data.fields.assignee.displayName : 'Unassigned'}`);
        console.log(`Comments: ${data.fields.comment.comments.map(c => c.body).join('\n')}`);

        return data.fields;
    } catch (error) {
        console.error('Error fetching JIRA ticket:', error);
        return 'No details found'; // rethrow for further handling
    }
};

const get_work_status = async (jql) => {
    try {
        const response = await axios.get(`${JIRA_API_URL}/rest/api/3/search`, {
            params: {
                jql: jql, // Pass the JQL query in the params
                fields: 'summary,status,assignee,comment,customfield_10020', // Specify the fields you want
            },
            auth: {
                username: JIRA_API_USER,
                password: JIRA_API_TOKEN,
            },
            headers: {
                'Accept': 'application/json'
            }
        });

        const tickets = response.data.issues;

        return tickets;
    } catch (error) {
        console.error('Error fetching JIRA tickets:', error);
    }
};

// Routes
app.post('/chat', async (req, res) => {
    try {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        let JIRA_FULL_PROMPT = JIRA_PROMPT.replace('{{JIRA_INFO}}', JSON.stringify({ JIRA_PROJECT_KEY, JIRA_PROJECT_NAME }));

        const response = await anthropic.messages.create({
            model: 'claude-3-sonnet-20240229',
            system: JIRA_FULL_PROMPT,
            max_tokens: 1500,
            temperature: 0.1,
            messages: [{ role: 'user', content: message }]
        });


        const content = response.content[0].text;
        // res.json({ content });
        // return
        let result;

        try {
            const parsedContent = JSON.parse(content);
            if (parsedContent.function_call) {
                // Extract function name and arguments
                const match = parsedContent.function_call.match(/(\w+)\((.*)\)/);
                if (match) {
                    const [, functionName, args] = match;
                    const jql = args.trim().replace(/^"|"$/g, '');

                    // Call the appropriate function
                    let functionResult;
                    if (functionName === 'get_work_status') {
                        functionResult = await get_work_status(jql);
                    } else if (functionName === 'get_ticket_details') {
                        functionResult = await get_ticket_details(args);
                    }

                    // Pass the result back to Claude for summarization
                    const summaryResponse = await anthropic.messages.create({
                        model: 'claude-3-haiku-20240307',
                        system: JIRA_FULL_PROMPT,
                        max_tokens: 1500,
                        temperature: 0.1,
                        messages: [
                            { role: 'user', content: message },
                            { role: 'assistant', content: content },
                            { role: 'user', content: `Here is the function result: ${JSON.stringify(functionResult)}, do not use field names from JIRA in your response.` }
                        ]
                    });

                    result = summaryResponse.content[0].text;
                } else {
                    result = "Function call format is incorrect.";
                }
            } else {
                result = content;
            }
            result = JSON.parse(result)

        } catch (parseError) {
            // If parsing fails, it's not JSON, so just return the content as-is
            result = content;
        }

        res.json({ result });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while processing your request' });
    }
});

app.post('/join-waitlist', async (req, res, next) => {
    try {
        const { email, feedback } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        let region = 'Unknown';

        try {
            const geoResponse = await axios.get(`https://ipinfo.io/${userIp}?token=${process.env.IP_INFO_TOKEN}`);
            region = geoResponse.data.region; // Extract region (can also use 'country', etc.)
        } catch (geoError) {
            console.error('Error fetching geolocation:', geoError.message);
        }

        // Use the db config to interact with the PostgreSQL database
        const query = 'INSERT INTO waitlist (email, feedback, region) VALUES ($1, $2, $3) RETURNING id';
        const values = [email, feedback, region];

        try {
            const result = await db.query(query, values);
            res.json({ message: 'You have been added to the waitlist', id: result.rows[0].id });
        } catch (e) {
            next(e);
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'An error occurred while processing your request' });
    }
})

// Add new routes
app.get('/jira/ticket', async (req, res) => {
    try {
        const { ticketId } = req.query;
        const ticket = await get_ticket_details(ticketId);
        res.json(ticket);
    } catch (error) {
        console.error('Error fetching JIRA ticket:', error);
        res.status(500).json({ error: 'An error occurred while fetching the JIRA ticket' });
    }
});

app.get('/jira/updated-tickets', async (req, res) => {
    try {
        const { jql } = req.query;
        if (!jql) {
            return res.status(400).json({ error: 'JQL query is required' });
        }
        const tickets = await get_work_status(jql);
        res.json(tickets);
    } catch (error) {
        console.error('Error fetching updated JIRA tickets:', error);
        res.status(500).json({ error: 'An error occurred while fetching updated JIRA tickets' });
    }
});

app.use(errorHandler);

// Start server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});