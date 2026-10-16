/* global SIP */
/*
    Copyright 2025 Dixmit
    License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).
    This service will contain all the logic necessary for the integration
    with the SIP.
*/
import {_t} from "@web/core/l10n/translation";
import {loadBundle} from "@web/core/assets";
import {reactive} from "@odoo/owl";
import {registry} from "@web/core/registry";

export class VoipAgent {
    constructor(env, services) {
        this.toneAudio = new window.Audio();
        this.callAudio = new window.Audio();
        this.callAudio.autoplay = true;
        this.voip = services.voip_oca;
        this.multiTab = services.multi_tab;
        this.orm = services.orm;
        this.notification = services.notification;
        this.session = false;
        this.isMuted = false;
        this.isHolded = false;
        this.store = services["mail.store"];
        this.connectAgent();
        return reactive(this);
    }
    get hasRtcSupport() {
        return Boolean(
            navigator.mediaDevices &&
                navigator.mediaDevices.getUserMedia &&
                window.MediaStream
        );
    }
    get agentConfig() {
        return {
            authorizationPassword: this.voip.pbx_password,
            authorizationUsername: this.voip.pbx_username,
            delegate: {
                onCallHangup: () => {
                    this.voip.inCall = false;
                },
                onInvite: this.onInvite.bind(this),
                onDisconnect: this._onDisconnect.bind(this),
            },
            logBuiltinEnabled: odoo.debug !== "",
            logLevel: odoo.debug === "" ? "error" : "debug",
            transportOptions: {
                server: this.voip.pbx_ws,
            },
            uri: SIP.UserAgent.makeURI(
                `sip:${this.voip.pbx_username}@${this.voip.pbx_domain}`
            ),
            userAgentString: `OCA SIP.js/${window.SIP.version}`,
        };
    }
    async connectAgent() {
        if (this.voip.mode !== "prod") {
            console.info("Voip agent is not available in non-production mode");
            return;
        }
        this.voip.status = "connecting";
        if (!this.hasRtcSupport) {
            console.info("Voip agent is not available in this browser");
            return;
        }
        if (!this.voip.pbx_ws || !this.voip.pbx_username || !this.voip.pbx_password) {
            console.info("Some PBX information is missing. Check your configuration");
            return;
        }
        /*
            We want to avoid errors on the navigator.
            We will only load the libraries if needed
        */
        try {
            await loadBundle("voip_oca.agent_assets");
        } catch (error) {
            console.error(error);
            this.notification.add(
                _t("Failed to load the SIP.js library:\n\n%(error)s", {
                    error: error.message,
                })
            );
            return;
        }
        try {
            this.agent = new SIP.UserAgent(this.agentConfig);
            await this.agent.start();
            this.registerer = new SIP.Registerer(this.agent);
            this.registerer.stateChange.addListener(
                this._onRegistererStateChange.bind(this)
            );
            this.registerer.register({
                requestDelegate: {
                    onReject: this._onRegistererRejected.bind(this),
                },
            });
            this.voip.status = "connected";
        } catch (error) {
            console.error(error);
            this.voip.status = "disconnected";
            this.notification.add(
                _t(
                    "An error occurred during the instantiation of the User Agent:\n\n%(error)s",
                    {
                        error: error.message,
                    }
                )
            );
            return;
        }
    }
    async reconnectAgent(attempt = 0) {
        // TODO: Show the failure in the widget somehow....
        if (attempt >= 5) {
            this.notification.add(
                _t("Failed to reconnect the User Agent. Please reload the page.")
            );
            this.voip.status = "disconnected";
            return;
        }
        if (this.reconnectingAgent) {
            return;
        }
        this.reconnectingAgent = true;
        try {
            await this.agent.reconnect();
            this.registerer.register();

            this.voip.status = "connected";
        } catch {
            // Reconnect immediately if the connection fails, then 5 seconds, then 25, 125, 625
            setTimeout(() => this.reconnectAgent(attempt + 1), 5 ** attempt * 1000);
        } finally {
            this.reconnectingAgent = false;
        }
    }
    playTone(tone) {
        if (!this.voip.tones || !this.voip.tones[tone]) {
            return;
        }
        this.toneAudio.currentTime = 0;
        this.toneAudio.loop = true;
        this.toneAudio.src = this.voip.tones[tone];
        const playPromise = this.toneAudio.play();
        if (playPromise !== undefined) {
            playPromise.catch((err) => {
                console.warn("VoIP tone play prevented or interrupted:", err);
            });
        }
    }
    stopTone() {
        try {
            this.toneAudio.pause();
            this.toneAudio.currentTime = 0;
        } catch (_) {}
    }
    /* On call actions */
    async onInvite(session) {
        if (this.session && this.session.state !== SIP.SessionState.Terminated) {
            // We are busy here
            session.reject({statusCode: 486});
            return;
        }
        this.session = session;
        this.isMuted = false;
        this.isHolded = false;

        session.delegate = {
            onBye: this._onHanghup.bind(this),
            onCancel: this._onCancelInvitation.bind(this),
        };
        session.stateChange.addListener(this._onSessionStateChange.bind(this));

        // Send 180 Ringing to Asterisk immediately so the caller hears ringing
        try {
            session.progress();
        } catch (err) {
            console.warn("Could not send 180 Ringing progress:", err);
        }

        try {
            await this.createCall({
                phone_number: session.remoteIdentity?.uri?.user || "Unknown",
                type_call: "incoming",
                state: "calling",
            });
        } catch (err) {
            console.warn("Could not create call record in backend:", err);
            if (!this.voip.call) {
                this.voip.call = {
                    phoneNumber: session.remoteIdentity?.uri?.user || "Unknown",
                    typeCall: "incoming",
                    state: "calling",
                    dateStr: "",
                    iconTypeCall: "fa fa-phone",
                };
            }
        }

        this.voip.inCall = true;
        this.voip.isOpened = true;
        this.voip.isFolded = false;

        /* Play calltone if on main tab or single tab */
        if (!this.multiTab || this.multiTab.isOnMainTab()) {
            this.playTone("calltone");
        }
    }
    _onDisconnect(error) {
        if (!error) {
            return;
        }
        console.error(error);
        this.notification.add(
            _t("An error occurred during the connection:\n\n%(error)s", {
                error: error.message,
            })
        );

        this.voip.status = "connecting";
        this.reconnectAgent();
    }
    _onSessionStateChange(newState) {
        switch (newState) {
            case SIP.SessionState.Initial:
            case SIP.SessionState.Terminating:
            case SIP.SessionState.Establishing:
                break;
            case SIP.SessionState.Terminated:
                // We need to stop the tone if it was not established
                this.stopTone();
                this.session = false;
                this.voip.inCall = false;
                break;
            case SIP.SessionState.Established:
                this.stopTone();
                this.setCallAudio();
                this.updateCallAudio();
                this.session.sessionDescriptionHandler.remoteMediaStream.onaddtrack =
                    this.setCallAudio.bind(this);
                break;
            default:
                throw new Error(`Unknown session state: "${newState}".`);
        }
    }
    setCallAudio() {
        /* We need to set the call audio of the session */
        const stream = new MediaStream();
        const receivers =
            this.session?.sessionDescriptionHandler?.peerConnection?.getReceivers() || [];
        for (const receiver of receivers) {
            if (receiver.track) {
                stream.addTrack(receiver.track);
            }
        }
        if (
            stream.getTracks().length === 0 &&
            this.session?.sessionDescriptionHandler?.remoteMediaStream
        ) {
            for (const track of this.session.sessionDescriptionHandler.remoteMediaStream.getTracks()) {
                stream.addTrack(track);
            }
        }
        this.callAudio.autoplay = true;
        this.callAudio.srcObject = stream;
        const playPromise = this.callAudio.play();
        if (playPromise !== undefined) {
            playPromise.catch((err) => {
                console.warn("Call audio play prevented:", err);
            });
        }
    }
    updateCallAudio() {
        if (this.session?.sessionDescriptionHandler) {
            this.session.sessionDescriptionHandler.enableReceiverTracks(this.isHolded);
            this.session.sessionDescriptionHandler.enableSenderTracks(
                !this.isHolded && !this.isMuted
            );
        }
    }
    async createCall(options) {
        const call = await this.orm.call("voip.call", "create_call", [
            {
                pbx_id: this.voip.pbx_id,
                ...options,
            },
        ]);

        this.voip.call = this.store.Call.insert(call);
        if (call.partner) {
            this.voip.partner = this.store.Persona.insert({...call.partner});
        }
    }
    async call({number, partner}) {
        console.log(arguments);
        this.voip.isOpened = true;
        this.voip.isFolded = false;
        var phone_number = number;
        if (!number && partner) {
            phone_number = partner.mobileNumber || partner.landlineNumber;
        }
        this.playTone("dialtone");
        await this.createCall({
            partner_id: partner && partner.id,
            phone_number: phone_number,
            type_call: "outgoing",
            state: "calling",
        });
        this.voip.inCall = true;
        if (this.voip.mode === "prod") {
            const cleanNumber = (phone_number || "").replace(/[^\d*#+]/g, "");
            if (!cleanNumber) {
                this.stopTone();
                this.voip.inCall = false;
                this.notification.add(_t("Please enter a valid phone number."));
                return;
            }
            if (!this.agent) {
                this.stopTone();
                this.voip.inCall = false;
                this.notification.add(_t("SIP Agent is not ready. Please reload the page."));
                return;
            }
            const destination_number = SIP.UserAgent.makeURI(
                `sip:${cleanNumber}@${this.voip.pbx_domain}`
            );
            if (!destination_number) {
                this.stopTone();
                this.voip.inCall = false;
                this.notification.add(
                    _t("Invalid SIP URI for number: %(number)s", { number: cleanNumber })
                );
                return;
            }
            try {
                this.session = new SIP.Inviter(this.agent, destination_number);
                this.session.delegate = {
                    onBye: this._onHanghup.bind(this),
                };
                this.isMuted = false;
                this.isHolded = false;
                this.session.stateChange.addListener(this._onSessionStateChange.bind(this));
                this.session
                    .invite({
                        requestDelegate: {
                            onAccept: this._onInviteAccepted.bind(this),
                            onReject: this._onInviteRejected.bind(this),
                        },
                    })
                    .catch((error) => {
                        // This might happen, for example, if we close the call too early.
                        this.stopTone();
                        this.notification.add(
                            _t("Failed to establish the call:\n\n%(error)s", {
                                error: error?.message || error,
                            })
                        );
                    });
            } catch (error) {
                this.stopTone();
                this.voip.inCall = false;
                console.error("Failed to create SIP inviter:", error);
                this.notification.add(
                    _t("Failed to initiate call:\n\n%(error)s", {
                        error: error?.message || error,
                    })
                );
            }
        }
    }
    transfer(number) {
        if (this.voip.mode !== "prod") {
            this._onHanghup();
            return;
        }
        this.session.refer(
            SIP.UserAgent.makeURI(`sip:${number}@${this.voip.pbx_domain}`),
            {
                requestDelegate: {
                    onAccept: this._onTransferAccepted.bind(this),
                },
            }
        );
    }
    _onTransferAccepted() {
        this.session.bye();
        this._onHanghup();
    }
    _onInviteAccepted() {
        if (!this.session) {
            return;
        }
        this.stopTone();
        this.voip.acceptCall();
    }
    _onInviteRejected(response) {
        if (!this.session) {
            return;
        }
        this.stopTone();
        this.notification.add(
            _t("Call rejected. Reason:\n\n%(reason)s", {
                reason: response.message.reasonPhrase,
            })
        );
        this.voip.rejectCall();
        this.session = null;
    }
    async _onCancelInvitation() {
        this.stopTone();
        this.voip.rejectCall();
        this.session = null;
    }
    async _onHanghup() {
        this.stopTone();
        this.callAudio.srcObject = null;
        this.callAudio.pause();
        if (this.voip?.call?.id) {
            try {
                this.voip.call.update(
                    await this.orm.call("voip.call", "terminate_call", [[this.voip.call.id]])
                );
            } catch (err) {
                console.warn("Failed to terminate call in ORM:", err);
            }
        }
        this.voip.inCall = false;
        this.session = false;
    }
    async hangup() {
        if (this.session) {
            switch (this.session.state) {
                case SIP.SessionState.Initial:
                    if (this.voip.call.typeCall === "outgoing") {
                        this.session.cancel();
                    } else {
                        this.session.reject();
                    }
                    break;
                case SIP.SessionState.Establishing:
                    this.session.cancel();
                    break;
                case SIP.SessionState.Established:
                    this.session.bye();
                    break;
            }
        }
        this._onHanghup();
    }
    async mute() {
        this.isMuted = !this.isMuted;
        this.updateCallAudio();
    }
    async hold() {
        this.isHolded = !this.isHolded;
        try {
            await this.session.invite({
                requestDelegate: {
                    onReject() {
                        this.isHolded = !this.isHolded;
                    },
                },
                sessionDescriptionHandlerOptions: {hold: this.isHolded},
            });
        } catch (error) {
            console.error(error);
            this.notification.add(
                _t("Failed to put the call on hold/unhold:\n\n%(error)s", {
                    error: error.message.reasonPhrase,
                })
            );
        }
        this.updateCallAudio();
    }
    async accept() {
        if (this.session) {
            this.session.accept();
        }
        this.voip.acceptCall();
    }
    /* Registerer functions */
    async _onRegistererRejected(response) {
        this.notification.add(
            _t(
                "An error occurred during the registration of the User Agent:\n\n%(error)s",
                {
                    error: response.message.reasonPhrase,
                }
            )
        );
    }
    _onRegistererStateChange(state) {
        this.registererState = state;
    }
}

export const voipAgentOCAService = {
    dependencies: ["voip_oca", "multi_tab", "notification", "orm", "mail.store"],
    async start() {
        return new VoipAgent(...arguments);
    },
};

registry.category("services").add("voip_agent_oca", voipAgentOCAService);
