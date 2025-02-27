import fetch from 'node-fetch';
import fs from 'fs/promises';

// The repositories to check for updates.
const repositories = [
	'jackocnr/intl-tel-input',
	'cure53/DOMPurify',
	'chartjs/Chart.js',
	'Choices-js/Choices',
	'WordPress/plugin-check',
];

// The file to save the cache of checked versions.
const CACHE_FILE = '.github/actions/setup-libs-update-detector/checked_versions_1.json';

// The URL of the repository to create issues on.
const repoUrl = 'https://api.github.com/repos/wayheming/libs-detector/issues';

// Load the cache file if it exists, or create an empty object.
async function loadCache() {
	try {
		const data = await fs.readFile(CACHE_FILE, 'utf8');
		return JSON.parse(data);
	} catch (err) {
		return {};
	}
}

// Save the cache object to a file.
async function saveCache(cache) {
	try {
		await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
	} catch (err) {
		console.error('Error saving cache:', err.message);
	}
}

// Fetch the latest release data for a repository.
async function fetchRepositoryData(repoName) {
	const url = `https://api.github.com/repos/${repoName}/releases`;

	const response = await fetch(url);

	if (!response.ok) {
		console.error(`Error fetching data for ${repoName}: ${response.statusText}`);
		return null;
	}

	const releases = await response.json();
	return releases[0] || null;
}

// Send a message to a Slack channel.
async function sendToSlack(message) {
	const url = process.env.SLACK_WEBHOOK;
	
	const payload = {
		data: message
	};

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		console.error(`Error sending message to Slack: ${response.statusText}`);
	}
}

// Call the OpenAI API to analyze a release description.
async function callGPTAPI(description, repo, version, url) {
	const apiUrl = 'https://api.openai.com/v1/chat/completions';

	const response = await fetch(apiUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
		},
		body: JSON.stringify({
			model: 'gpt-4o',
			messages: [
				{
					role: 'user',
					content: `
            You're a WPForms Developer trying to determine the significance of a new library update.
            Here's a release description/changelog for evaluation: "${description}"
            
            Please provide a structured JSON output with the following keys:
            - "library": ${repo}
            - "version": ${version}
            - "URL": ${url}
            - "severity": Determined based on the following rules:
              •	"low": Cosmetic updates or documentation changes.
              •	"medium": Bug fixes or minor performance improvements.
              •	"high": Security patches, critical bug fixes, or major new features.
            - "ai-summary": A brief AI-generated summary of the release.

           Return only clean and valid JSON text without.
           Give me the response without JSON formatting.
            
            Example response:
            {
              "library": "example-library",
              "version": "1.2.3",
              "URL": "https://example.com",
              "severity": "medium",
              "ai-summary": "This release fixes several security vulnerabilities."
            }
          `,
				},
			],
		}),
	});

	if (!response.ok) {
		console.error(`Error calling OpenAI API: ${response.statusText}`);
		return 'Failed to evaluate with AI.';
	}

	const json = await response.json();
	const structuredOutput = json.choices[0].message.content;

	return JSON.parse(structuredOutput);
}

// Create a new issue on a GitHub repository.
async function createGitHubIssue(title, body) {
	const token = process.env.GITHUB_TOKEN;

	const response = await fetch(repoUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			title: title,
			body: body,
			assignees: ['wayheming']
		}),
	});

	if (!response.ok) {
		console.error(`Failed to create issue: ${response.status} ${response.statusText}`);
		const errorDetails = await response.json();
		console.error(errorDetails);
		throw new Error('Error creating GitHub issue');
	}

	const issueData = await response.json();
	console.log(`Issue created: ${issueData.html_url}`);
	return issueData.html_url;
}

function createSlackMessage(repo, tag_name, html_url, aiAnalysis, issueUrl) {
	return `Hello team! :wave:

${repo} has a new ${aiAnalysis.severity === 'high' ? '🚨 HIGH' : '⚠️ MEDIUM'} priority update to version ${tag_name} \n
${aiAnalysis.severity === 'medium' ? `:brain: AI Summary: ${aiAnalysis['ai-summary']}\n` : ''}
${aiAnalysis.severity === 'medium' ? `:link: Release details: ${html_url}\n` : ''}
${issueUrl ? `👉 GitHub issue: ${issueUrl}` : ''}`;
}

function createGitHubIssueMessage(repo, tag_name, html_url, aiAnalysis) {
	const documentationLinks = {
		'jackocnr/intl-tel-input': 'https://github.com/awesomemotive/wpforms-plugin/wiki/Phone-field%27s-%60intl%E2%80%90tel%E2%80%90input%60-library',
		'cure53/DOMPurify': 'https://github.com/awesomemotive/wpforms-plugin/wiki/DOMPurify-Lib-Update-testing'
	};

	const docLink = documentationLinks[repo] 
		? `\n\n## Testing Documentation\nPlease follow the testing guidelines here: ${documentationLinks[repo]}` 
		: '';

	return `
## Release Details
- **Version:** ${tag_name}
- **Severity:** ${aiAnalysis.severity.toUpperCase()}
- **Release URL:** ${html_url}

## AI Analysis Summary
${aiAnalysis['ai-summary']}
${docLink}

---
*This issue was automatically created by the Library Update Detector.*`;
}

// Main function to check for updates.
(async () => {
	const cache = await loadCache();

	console.log(cache);

	for (const repo of repositories) {
		const release = await fetchRepositoryData(repo);

		if (!release) {
			console.log(`No release data found for ${repo}.`);
			continue;
		}

		const { tag_name, html_url, body } = release;

		if (cache[repo] && cache[repo].includes(tag_name)) {
			console.log(`Version ${tag_name} of ${repo} is already checked. Skipping.`);
			continue;
		}

		let aiAnalysis;
		try {
			aiAnalysis = await callGPTAPI(body, repo, tag_name, html_url);
		} catch (err) {
			console.error(`Error analyzing release with AI for ${repo}:`, err.message);
			continue;
		}

		if (aiAnalysis) {
			if (aiAnalysis.severity !== 'low') {
				let issueUrl;
				
				if (aiAnalysis.severity === 'high') {
					const issueMessage = createGitHubIssueMessage(repo, tag_name, html_url, aiAnalysis);

					try {
						issueUrl = await createGitHubIssue(
							`[${repo}] High-Priority Update v${tag_name}`, 
							issueMessage
						);
					} catch (err) {
						console.error(`Error creating issue for ${repo}:`, err.message);
						continue;
					}
				}

				const slackMessage = createSlackMessage(repo, tag_name, html_url, aiAnalysis, issueUrl);

				try {
					await sendToSlack(slackMessage);
				} catch (err) {
					console.error(`Error sending message to Slack for ${repo}:`, err.message);
					continue;
				}
			}
		}

		if (!cache[repo]) {
			cache[repo] = [];
		}
		cache[repo] = [tag_name];
		try {
			await saveCache(cache);
			console.log('Cache saved successfully.');
		} catch (err) {
			console.error('Error saving cache:', err);
		}
		console.log('After saving cache:', JSON.stringify(cache, null, 2));
	}
})();
