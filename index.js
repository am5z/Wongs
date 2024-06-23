const { Client } = require('ssh2');
const fs = require('fs');
const axios = require('axios');
const readline = require('readline');
const path = require('path');
const CatLoggr = require('cat-loggr');
const loggr = new CatLoggr();

const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));

const prompt = (query) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => rl.question(query, (ans) => {
        rl.close();
        resolve(ans);
    }));
};

const installNode = async (ip, nodeName, hostname) => {
    const conn = new Client();
    const sshConfig = {
        host: ip,
        port: settings.ssh_auth.port,
        username: settings.ssh_auth.user
    };

    if (settings.ssh_auth.type === 'sshkey') {
        sshConfig.privateKey = fs.readFileSync(settings.ssh_auth.sshkey_path);
    } else {
        sshConfig.password = settings.ssh_auth.password;
    }

    conn.on('ready', async () => {
        loggr.init(`Connected to node ${nodeName} (${ip})!`);

        const executeCommand = (command) => {
            return new Promise((resolve, reject) => {
                conn.exec(command, { pty: true }, (err, stream) => {
                    if (err) return reject(err);

                    stream
                        .on('close', (code, signal) => {
                            resolve();
                        })
                        .on('data', (data) => {
                            if (data.toString().includes('password for')) {
                                stream.write(`${settings.ssh_auth.password}\n`);
                            }

                            if (data.toString().includes('sftp server listening for connections')) {
                                loggr.info(`Node ${nodeName} is now set up and online.`);
                                conn.end();
                            }
                        })
                        .stderr.on('data', (data) => {});
                });
            });
        };

        try {
            loggr.info(`Setting up node ${nodeName}...`);
            const commands = [
                'sudo curl -sSL https://get.docker.com/ | CHANNEL=stable bash',
                'sudo systemctl enable --now docker',
                'sudo mkdir -p /etc/pterodactyl',
                'sudo curl -L -o /usr/local/bin/wings "https://github.com/pterodactyl/wings/releases/latest/download/wings_linux_amd64"',
                'sudo chmod u+x /usr/local/bin/wings',
            ];

            for (const command of commands) {
                await executeCommand(command);
            }

            loggr.info(`Creating node ${nodeName} on Panel...`);
            const apiKey = settings.pterodactyl.key;
            const panelUrl = `${settings.pterodactyl.url}/api/application/nodes`;
            const nodeResponse = await axios.post(panelUrl, {
                name: nodeName,
                location_id: settings.pterodactyl.node.locationId,
                fqdn: hostname,
                scheme: 'https',
                memory: settings.pterodactyl.node.memory,
                memory_overallocate: 10000,
                disk: settings.pterodactyl.node.disk,
                disk_overallocate: 1000,
                upload_size: 500,
                daemon_sftp: 2022,
                daemon_listen: 8080
            }, {
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                }
            });

            const nodeId = nodeResponse.data.attributes.id;

            loggr.info(`Configuring Wings for node ${nodeName} and installing packages...`);
            await executeCommand(`cd /etc/pterodactyl && sudo wings configure --panel-url ${settings.pterodactyl.url} --token ${apiKey} --node ${nodeId}`);
            await executeCommand('sudo apt install certbot -y');

            loggr.info(`Generating SSL certificate for node ${nodeName}...`);
            await executeCommand(`sudo certbot certonly --agree-tos --non-interactive --email "${settings.certbot_email}" --standalone -d ${hostname}`);

            loggr.info(`Booting Wings for node ${nodeName}...`);
            await executeCommand('sudo wings');

            loggr.info(`Wings setup completed successfully for node ${nodeName}.`);
        } catch (error) {
            loggr.error(`Error setting up Wings for node ${nodeName}:`, error);
        } finally {
            conn.end();
        }
    }).connect(sshConfig);
};

(async () => {
    console.log(fs.readFileSync('./ascii.txt').toString());
    const serverCount = parseInt(await prompt('How many servers would you like to deploy? Amount: '), 10);

    const serverDetails = [];
    for (let i = 1; i <= serverCount; i++) {
        const ip = await prompt(`Enter the IPv4 address for server ${i}: `);
        const nodeName = await prompt(`Enter the node name for server ${i}: `);
        const hostname = await prompt(`Enter the DNS record / hostname for server ${i}: `);
        serverDetails.push({ ip, nodeName, hostname });
    }

    for (let i = 0; i < serverCount; i++) {
        const { ip, nodeName, hostname } = serverDetails[i];
        setTimeout(() => {
            installNode(ip, nodeName, hostname);
        }, i * 15000);
    }
})();
