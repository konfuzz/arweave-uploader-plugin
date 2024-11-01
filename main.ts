import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, getLinkpath, requestUrl, arrayBufferToBase64 } from 'obsidian';
import Arweave from 'arweave';
import { marked } from 'marked';

interface ArweaveUploaderSettings {
	privateKey: string;
}

const DEFAULT_SETTINGS: ArweaveUploaderSettings = {
	privateKey: ''
}

const arweave = Arweave.init({
	host: 'arweave.net',
	port: 443,
	protocol: 'https'
});

export default class ArweaveUploader extends Plugin {
	settings: ArweaveUploaderSettings;

	async onload() {
		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon('cloud-upload', 'Arweave Uploader', async (evt: MouseEvent) => {
			this.openModal();
		});

		this.addCommand({
			id: 'open-modal',
			name: 'Open modal',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					if (!checking) {
						this.openModal();
					}
					return true;
				}
				return false;
			}
		});

		this.addSettingTab(new ArweaveUploaderSettingTab(this.app, this));
	}

	onunload() {
		
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
	async openModal() {
		let html = await this.exportToHtml();
		if (html) {
			const images = this.getImageAttachmentsFromCurrentNote(this.app);
			for (const image of images) {
				const base64 = await this.convertImageToBase64(this.app, image);
				html = html.replace(`![[${image.name}]]`, `<img src="${base64}" alt="${image.name}">`);
			}
			new ArweaveUploaderModal(this.app, await this.getTransactionPrice(html), html, this).open();
		} else {
			new Notice('No active note to export');
		}
	}
	
	async exportToHtml() {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			const content = await this.app.vault.read(activeFile);
			const htmlContent = marked(content);
			const fullHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${activeFile.basename}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.min.css">
</head>
<body>
  ${htmlContent}
</body>
</html>
`;
			return fullHtml;
		}
		return null;
	}

	getImageAttachmentsFromCurrentNote(app: App): TFile[] {
		const currentNote = app.workspace.getActiveFile();
		
		if (!currentNote) {
			new Notice('No active note to export');
			return [];
		}
	
		const cache = app.metadataCache.getFileCache(currentNote);
		const attachments: TFile[] = [];
	
		if (cache?.embeds) {
			for (const embed of cache.embeds) {
				if (embed.link) {
					const linkPath = getLinkpath(embed.link);
					const file = app.metadataCache.getFirstLinkpathDest(linkPath, currentNote.path);
					
					if (file instanceof TFile && file.extension.match(/png|jpg|jpeg|gif|bmp|svg/i)) {
						attachments.push(file);
					}
				}
			}
		}
	
		return attachments;
	}

	async convertImageToBase64(app: App, file: TFile): Promise<string> {
		const arrayBuffer = await app.vault.readBinary(file);
		const base64String = arrayBufferToBase64(arrayBuffer);
		const mimeType = this.getMimeType(file.extension);
		return `data:${mimeType};base64,${base64String}`;
	}
	
	getMimeType(extension: string): string {
		const mimeTypes: {[key: string]: string} = {
			'png': 'image/png',
			'jpg': 'image/jpeg',
			'jpeg': 'image/jpeg',
			'gif': 'image/gif',
			'bmp': 'image/bmp',
			'svg': 'image/svg+xml'
		};
		return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
	}

	async uploadToArweave(html: string) {
		const wallet = JSON.parse(this.settings.privateKey);
		try {
			const transaction = await arweave.createTransaction({
				data: html
			}, wallet);

			transaction.addTag('Content-Type', 'text/html');

			await arweave.transactions.sign(transaction, wallet);
			const response = await arweave.transactions.post(transaction);

			if (response.status === 200 || response.status === 202) {
				const url = `https://arweave.net/${transaction.id}`;
				return url;
			} else {
				throw new Error(`Transaction failed with status ${response.status}`);
			}
		} catch (error) {
			new Notice('Error uploading to Arweave: ' + error);
			throw error;
		}
	}

	async getTransactionPrice(data: string) {
		try {
			const priceInWinston = await arweave.transactions.getPrice(data.length);
			
			const priceInAR = arweave.ar.winstonToAr(priceInWinston);
			const txCost = Math.round(Number(await this.getArPriceInUSD()) * Number(priceInAR) * 10000) / 10000;
			return `Transaction cost: ~${priceInAR} AR (${txCost}$)`;
		} catch (error) {
			new Notice('Error calculating transaction price: ' + error);
			throw error;
		}
	}

	async getArPriceInUSD() {
		const response = await requestUrl('https://api.coingecko.com/api/v3/simple/price?ids=arweave&vs_currencies=usd');
		const data = response.json;
		return data.arweave.usd;
	}

	async getBalanceByPrivateKey(): Promise<string> {
		try {
			const wallet = JSON.parse(this.settings.privateKey);
			
			const address = await arweave.wallets.getAddress(wallet);
			
			const balanceInWinston = await arweave.wallets.getBalance(address);
			
			const balanceInAR = arweave.ar.winstonToAr(balanceInWinston);
			return balanceInAR;
		} catch (error) {
			new Notice('Error getting balance: ' + error);
			throw error;
		}
	}
	
	
}

class ArweaveUploaderModal extends Modal {
	priceInUSD: string;
	data: string;
	plugin: ArweaveUploader;

	constructor(app: App, priceInUSD: string, data: string, plugin: ArweaveUploader) {
		super(app);
		this.priceInUSD = priceInUSD;
		this.data = data;
		this.plugin = plugin;
	}

	async onOpen() {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.createEl('p', { text: 'Your wallet balance: ' + await this.plugin.getBalanceByPrivateKey() + ' AR' });
		contentEl.createEl('p', { text: 'Transaction cost: ' + this.priceInUSD });

		const sendButton = contentEl.createEl('button', { text: 'Upload note to Arweave' });
        sendButton.onclick = async () => {
			sendButton.textContent = 'Uploading...';
            const url = await this.plugin.uploadToArweave(this.data);
            if (url) {
				contentEl.createEl('p', { text: 'Tx sent' });
                contentEl.createEl('a', { text: url, href: url });
            } else {
                new Notice('Error sending transaction');
            }
			sendButton.textContent = 'Upload note to Arweave';
        };
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class ArweaveUploaderSettingTab extends PluginSettingTab {
	plugin: ArweaveUploader;

	constructor(app: App, plugin: ArweaveUploader) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setClass('arweave-uploader-setting')
			.setName('Private key')
			.setDesc('Enter your wallet private key here')
			.addTextArea(text => {
				text
				.setPlaceholder('Enter your private key...')
				.setValue(this.plugin.settings.privateKey)
				.onChange(async (value) => {
					this.plugin.settings.privateKey = value;
					await this.plugin.saveSettings();
				})
			});
	}
}