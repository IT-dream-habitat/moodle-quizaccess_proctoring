// Whether the student currently has an active screen-share stream. Screen capture is a HARD
// requirement, same as the webcam: the exam cannot proceed without it, and stopping the share
// mid-exam re-blocks it until re-shared.
let screenShareActive = false;
let activeTakeScreenshot = null;

define(['jquery', 'core/ajax', 'core/notification', 'core/str'],
    function($, Ajax, Notification, Str) {
        const loadStrings = async function() {
            const stringkeys = [
                {key: 'warning:sharescreenwarning', component: 'quizaccess_proctoring'},
                {key: 'info:screenshareallowed', component: 'quizaccess_proctoring'},
                {key: 'screenshareended', component: 'quizaccess_proctoring'},
                {key: 'wrong_during_taking_screencapture', component: 'quizaccess_proctoring'},
                {key: 'sharescreenbutton', component: 'quizaccess_proctoring'},
                {key: 'sharescreentitle', component: 'quizaccess_proctoring'},
                {key: 'sharescreeninstructions', component: 'quizaccess_proctoring'},
                {key: 'sharescreenwrongsurface', component: 'quizaccess_proctoring'},
                {key: 'sharescreennotsupported', component: 'quizaccess_proctoring'},
                {key: 'sharescreengoback', component: 'quizaccess_proctoring'},
            ];
            try {
                const strings = await Str.get_strings(stringkeys);
                return {
                    sharescreenwarning: strings[0],
                    screenshareallowed: strings[1],
                    screenshareended: strings[2],
                    wrongduringtakingscreencapture: strings[3],
                    sharescreenbutton: strings[4],
                    sharescreentitle: strings[5],
                    sharescreeninstructions: strings[6],
                    sharescreenwrongsurface: strings[7],
                    sharescreennotsupported: strings[8],
                    sharescreengoback: strings[9],
                };
            } catch (error) {
                Notification.exception(error);
                return {};
            }
        };

        return {
            /**
             * Start periodic screen capture on the live quiz attempt page.
             *
             * Screen capture is a HARD requirement, same as the webcam: a full-screen overlay
             * blocks the exam until the student grants "Entire Screen" sharing, and reappears
             * if sharing is later stopped mid-exam.
             *
             * @param {Object} props courseid, quizid (cmid), id (pre-created screenshotlogid),
             *   image_width, screenshotdelay (ms).
             * @return {Promise<boolean>}
             */
            async init(props) {
                const strings = await loadStrings();

                // Skip on the quiz summary/review pages, same as the webcam capture loop.
                if (document.getElementById("page-mod-quiz-summary") !== null &&
                    document.getElementById("page-mod-quiz-summary").innerHTML.length) {
                    return false;
                }
                if (document.getElementById("page-mod-quiz-review") !== null &&
                    document.getElementById("page-mod-quiz-review").innerHTML.length) {
                    return false;
                }

                const width = props.image_width;
                const video = document.createElement('video');
                video.style.display = 'none';
                document.body.appendChild(video);
                const canvas = document.createElement('canvas');

                const takeScreenshot = async(captureorigin, tabswitchid) => {
                    // video.videoWidth/videoHeight can briefly read 0 right as the shared
                    // window/monitor loses OS focus or gets covered by another app (observed in
                    // real testing: a tab-switch violation landed with the webcam captured fine
                    // but the screenshot silently missing entirely, with no request ever reaching
                    // the server - an uncaught exception from drawImage() on a not-yet-ready
                    // frame, swallowed as an unhandled rejection since this function has no
                    // caller-side catch). Treat "not ready" the same as "not active": signal
                    // failure so captureNow()'s retry loop tries again instead of giving up after
                    // a single attempt.
                    if (!screenShareActive || !video.videoWidth || !video.videoHeight) {
                        return false;
                    }

                    try {
                        const height = video.videoHeight / (video.videoWidth / width);
                        canvas.width = width;
                        canvas.height = height;
                        const context = canvas.getContext('2d');
                        context.drawImage(video, 0, 0, width, height);
                        const data = canvas.toDataURL('image/png');

                        const request = {
                            methodname: 'quizaccess_proctoring_send_screenshot',
                            args: {
                                'courseid': props.courseid,
                                'screenshotlogid': props.id,
                                'quizid': props.quizid,
                                'screenshotpicture': data,
                                'captureorigin': captureorigin || 'interval',
                                'tabswitchid': tabswitchid || 0,
                            }
                        };

                        Ajax.call([request])[0].done(function(res) {
                            if (res.warnings.length >= 1) {
                                Notification.addNotification({
                                    message: strings.wrongduringtakingscreencapture,
                                    type: 'error'
                                });
                            }
                        }).fail(Notification.exception);

                        return true;
                    } catch (error) {
                        // eslint-disable-next-line no-console
                        console.error('quizaccess_proctoring: screenshot capture failed, will retry', error);
                        return false;
                    }
                };
                activeTakeScreenshot = takeScreenshot;

                let intervalhandle = null;

                // The blocking overlay. Built once, shown whenever screen sharing is not
                // currently active (first load, a failed/wrong-surface attempt, or after the
                // student stops an active share mid-exam), removed only on a successful
                // "Entire Screen" grant. There is no skip option: this is a hard requirement.
                const overlay = document.createElement('div');
                overlay.className = 'proctoring-screenshare-overlay';
                overlay.innerHTML = `
                    <div class="proctoring-screenshare-dialog">
                        <h3>${strings.sharescreentitle}</h3>
                        <p class="proctoring-screenshare-message">${strings.sharescreeninstructions}</p>
                        <button type="button" class="btn btn-primary proctoring-screenshare-share">
                            ${strings.sharescreenbutton}
                        </button>
                        <button type="button" class="btn btn-link proctoring-screenshare-goback">
                            ${strings.sharescreengoback}
                        </button>
                    </div>`;
                const messageEl = overlay.querySelector('.proctoring-screenshare-message');
                const shareBtn = overlay.querySelector('.proctoring-screenshare-share');
                const gobackBtn = overlay.querySelector('.proctoring-screenshare-goback');

                // A student who doesn't want to share their screen must still have a clean way
                // out, rather than being trapped on a blocking overlay with no escape but
                // closing the tab. This does not weaken the requirement - it's still impossible
                // to proceed with the exam without sharing - it just makes leaving explicit.
                // The attempt itself is simply abandoned in place, same as closing the tab would
                // do; Moodle handles that state on its own (resumable later, or auto-submitted
                // at the time limit, per the quiz's normal settings).
                gobackBtn.addEventListener('click', function() {
                    window.location.href = M.cfg.wwwroot + '/mod/quiz/view.php?id=' + props.quizid;
                });

                const showOverlay = function(message) {
                    messageEl.textContent = message || strings.sharescreeninstructions;
                    if (!overlay.isConnected) {
                        document.body.appendChild(overlay);
                    }
                };
                const hideOverlay = function() {
                    if (overlay.isConnected) {
                        overlay.remove();
                    }
                };

                const requestShare = async function() {
                    shareBtn.disabled = true;
                    try {
                        // displaySurface: 'monitor' hints the browser to default the picker
                        // towards "Entire Screen" rather than a single window/tab - it's only
                        // a preference the browser may use for its default selection, never a
                        // guarantee, since the human always keeps the final choice. We still
                        // verify what was actually granted below and reject anything else.
                        const stream = await navigator.mediaDevices.getDisplayMedia({
                            video: {displaySurface: 'monitor'}
                        });

                        // getSettings().displaySurface tells us what was ACTUALLY granted, when
                        // the browser reports it - support for this varies by browser AND by
                        // exact version, so treat it as a bonus signal, not something to rely on
                        // alone. A window or tab share is permanently locked to that single
                        // source by browser design - it can never show anything else the student
                        // switches to, so it does not satisfy the requirement.
                        const track = stream.getVideoTracks()[0];
                        const settings = track.getSettings();
                        // eslint-disable-next-line no-console
                        console.log('quizaccess_proctoring: getDisplayMedia settings', settings);

                        let looksLikeEntireScreen = true;
                        if (settings.displaySurface) {
                            looksLikeEntireScreen = settings.displaySurface === 'monitor';
                        } else {
                            // Fallback heuristic for browsers that don't report displaySurface at
                            // all: an entire-screen capture's resolution should closely match the
                            // actual screen resolution; a window or tab is very unlikely to
                            // coincidentally match it. Not foolproof (a maximized window could
                            // still slip through), but meaningfully better than trusting whatever
                            // was granted with no check at all.
                            const dpr = window.devicePixelRatio || 1;
                            const screenW = window.screen.width * dpr;
                            const screenH = window.screen.height * dpr;
                            const trackW = settings.width || 0;
                            const trackH = settings.height || 0;
                            looksLikeEntireScreen = screenW > 0 && screenH > 0 &&
                                (trackW / screenW) > 0.9 && (trackH / screenH) > 0.85;
                            // eslint-disable-next-line no-console
                            console.log('quizaccess_proctoring: displaySurface not reported, ' +
                                'falling back to resolution check', {trackW, trackH, screenW, screenH,
                                    looksLikeEntireScreen});
                        }

                        if (!looksLikeEntireScreen) {
                            track.stop();
                            showOverlay(strings.sharescreenwrongsurface);
                            shareBtn.disabled = false;
                            return;
                        }

                        video.srcObject = stream;
                        await video.play();
                        screenShareActive = true;
                        hideOverlay();
                        shareBtn.disabled = false;

                        Notification.addNotification({
                            message: strings.screenshareallowed,
                            type: 'success'
                        });

                        track.addEventListener('ended', function() {
                            screenShareActive = false;
                            if (intervalhandle) {
                                clearInterval(intervalhandle);
                            }
                            Notification.addNotification({
                                message: strings.screenshareended,
                                type: 'warning'
                            });
                            // Stopping mid-exam is treated the same as never having granted it:
                            // re-block until the student shares again.
                            showOverlay(strings.screenshareended);
                        });

                        setTimeout(takeScreenshot, 3000);
                        intervalhandle = setInterval(takeScreenshot, props.screenshotdelay);
                    } catch (error) {
                        // Declined or dismissed the picker: hard requirement, stay blocked and
                        // let the student try again.
                        screenShareActive = false;
                        showOverlay(strings.sharescreenwarning);
                        shareBtn.disabled = false;
                    }
                };

                shareBtn.addEventListener('click', requestShare);

                if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
                    // Not supported in this browser/webview at all: no amount of retrying will
                    // help, so say so plainly instead of leaving a dead "Share" button.
                    shareBtn.disabled = true;
                    showOverlay(strings.sharescreennotsupported);
                    return false;
                }

                showOverlay();

                return true;
            },

            /**
             * Capture a single screenshot immediately, outside the normal interval loop.
             * A safe no-op if screen sharing was never granted or has since stopped.
             *
             * @param {string} captureorigin Either 'interval' or 'violation'.
             * @param {number} tabswitchid Linked quizaccess_proctoring_tabswitch_logs id.
             * @return {Promise}
             */
            captureNow(captureorigin, tabswitchid) {
                // A violation can land right as a fresh question page has just loaded (each
                // question is a full page reload in Moodle's default quiz layout), while the
                // student's screen-share grant from this page is still being (re-)established -
                // giving up immediately in that split-second gap was producing violation rows
                // with no capture at all. Briefly retry instead of failing outright. If the
                // student hasn't granted screen sharing at all (blocked on the overlay), this
                // just delays the inevitable no-op by a few seconds - harmless.
                const maxwaitms = 5000;
                const intervalms = 250;
                let waited = 0;
                return new Promise((resolve) => {
                    const attempt = async() => {
                        if (screenShareActive && activeTakeScreenshot) {
                            const captured = await activeTakeScreenshot(captureorigin, tabswitchid);
                            if (captured) {
                                resolve();
                                return;
                            }
                        }
                        waited += intervalms;
                        if (waited >= maxwaitms) {
                            resolve();
                            return;
                        }
                        setTimeout(attempt, intervalms);
                    };
                    attempt();
                });
            }
        };
    });
