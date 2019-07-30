/** Copyright 2014-2018 Stewart Allen <so@a3z.co> -- All Rights Reserved */
"use strict";

/**
 * About
 *
 * provide raw socket, web socket, and web interface to serial-controlled
 * hardware such as FDM 3D printers and CNC mills based on marlin derived
 * firmwares.
 */

const version = "sv003";

const LineBuffer = require("./linebuffer");
const SerialPort = require('serialport');
const spawn = require('child_process').spawn;
const path = require('path');
const opt = require('minimist')(process.argv.slice(2));
const net = require('net');
const fs = require('fs');
const { exec } = require('child_process');

const oport = opt.device || opt.port || opt._[0]; // serial port device path
const baud = parseInt(opt.baud || "250000");      // baud rate for serial port

const os = require('os');
const url = require('url');
const http = require('http');
const serve = require('serve-static');
const moment = require('moment');
const connect = require('connect');
const WebSocket = require('ws');
const filedir = opt.dir || opt.filedir || `${process.cwd()}/tmp`;

const STATES = {
    IDLE: "idle",
    NODEVICE: "no controller",
    CONNECTING: "connecting",
    PRINTING: "printing",
    FLASHING: "flashing"
};

let bufmax = parseInt(opt.buflen || "8"); // max unack'd output lines
let port = oport;               // default port (possible to probe)
let checksum = !opt.nocheck;    // use line numbers and checksums
let lineno = 1;                 // next output line number
let starting = false;           // output phase just after reset
let waiting = 0;                // unack'd output lines
let maxout = 0;                 // high water mark for buffer
let paused = false;             // queue processing paused
let processing = false;         // queue being drained
let updating = false;           // true when updating firmware
let sdspool = false;            // spool to sd for printing
let dircache = [];              // cache of files in watched directory
let clients = [];               // connected clients
let buf = [];                   // output line buffer
let match = [];                 // queue for matching command with response
let collect = null;             // collect lines between oks
let sport = null;               // bound serial port
let upload = null;              // name of file being uploaded
let mode = 'marlin';            // operating mode
let debug = opt.debug;          // debug and dump all data
let extrude = true;             // enable / disable extrusion
let onboot = [                  // commands to run on boot (useful for abort)
    "M155 S2"       // report temp every 2 seconds
];
let boot_abort = [
    "G92 X0 Y0 Z0 E0",
    "M155 S2",      // report temp every 2 seconds
    "M104 S0 T0",   // extruder 0 heat off
    "M140 S0 T0",   // bed heat off
    "M107",         // shut off cooling fan
    "G91",          // relative moves
    "G0 Z10 X0 Y0", // drop bed 1cm
    "G28 X Y",      // home X & Y
    "G90",          // restore absolute moves
    "M84"           // disable steppers
];
let boot_error = [
    "G92 X0 Y0 Z0 E0",
    "M155 S2",      // report temp every 2 seconds
    "M104 S0 T0",   // extruder 0 heat off
    "M140 S0 T0",   // bed heat off
    "M107",         // shut off cooling fan
    "G91",          // relative moves
    "G0 Z10 X0 Y0", // drop bed 1cm
    "G90",          // restore absolute moves
    "M84"           // disable steppers
];

// marlin-centric, to be fixed
const status = {
    now: 0,                     // server's current time
    state: STATES.NODEVICE,     // server state
    clients: {
        ws: 0,                  // web socket client count
        net: 0,                 // direct network clients
        stdin: 0                // 1 of stdin active
    },
    buffer: {
        waiting: 0,             // unack'd output
        queue: 0,               // queue depth
        match: null,            // current outstanding commands
        collect: null           // lines collected against current command
    },
    flags: {                    // status of internal flags
        debug,                  // verbose serial port tracking
        extrude                 // extrusion enabled / disabled
    },
    device: {
        addr: [],               // ip addresses
        name: os.hostname(),    // device host name for web display
        version,                // version of code running
        firm: {                 // firmware version and author
            ver: "?",
            auth: "?"
        },
        ready: false,           // true when connected and post-init
        boot: 0,                // time of last boot
        connect: 0,             // time port was opened successfully
        close: 0,               // time of last close
        line: 0,                // time of last line output
        lines: 0,               // number of lines recieved from device
        lineno: 0               // last line # sent
    },
    error: {
        time: 0,                // time of last error
        cause: null             // last error message
    },
    print: {
        run: false,             // print running
        pause: false,           // true if paused
        clear: false,           // bed is clear to print
        filename: null,         // current file name
        outdir: null,           // output of current print (images)
        outseq: 0,              // output image sequence #
        progress: 0.0,          // 0.00-100% progress tracker
        prep: 0,                // gcode pre start time
        start: 0,               // gcode print start time
        mark: 0,                // gcode last line out time
        end: 0                  // gcode end of queue time
    },
    target: {                   // target temp
        bed: null,              // bed
        ext: [ null ]           // extruders
    },
    temp: {                     // measured temp
        bed: null,              // bed
        ext: [ null ]           // extruders
    },
    pos: {                      // current gcode position
        X: 0,
        Y: 0,
        Z: 0,
        E: 0
    },
    estop: {                    // endstop status
        min: {},
        max: {}
    },
    settings: {}                // map of active settings
};

// write line to all connected clients
function emit(line, flags) {
    const stat = flags && flags.status;
    const list = flags && flags.list;
    if (typeof(line) === 'object') {
        line = JSON.stringify(line);
    }
    clients.forEach(client => {
        let error = flags && flags.error;
        let cstat = (stat && client.request_status);
        let clist = (list && client.request_list) || (list && !flags.channel && !client.console);
        let cmatch = flags && flags.channel === client;
        if (error || cmatch || cstat || clist || (client.monitoring && !stat && !list)) {
            client.write(line + "\n");
            if (cstat) {
                client.request_status = false;
            }
            if (clist) {
                client.request_list = false;
            }
        }
    });
}

function cmdlog(line, flags) {
    if (debug) {
        return;
    }
    if (flags && flags.print && !opt.verbose) {
        return;
    }
    if (typeof(line) === 'object') {
        line = JSON.stringify(line);
    }
    emit("[" + waiting + ":" + bufmax + "," + buf.length + ":" + maxout + "] " + line, flags);
};

// send *** message *** to all clients (not stdout unless stdin specified)
function evtlog(line, flags) {
    if (typeof(line) === 'object') {
        line = JSON.stringify(line);
    }
    emit("*** " + line + " ***", flags);
};

// find the port with the controller
function probeSerial(then) {
    let match = null;
    SerialPort.list((err, ports) => {
        ports.forEach(port => {
            if (port.pnpId) {
                match = port.comName;
            } else if (port.manufacturer && port.manufacturer.toLowerCase().indexOf("arduino") >= 0) {
                match = port.comName;
            } else if (!match && (port.vendorId || port.productId || port.serialNumber)) {
                match = port.comnName;
            }
        });
        then(match);
    });
}

function openSerialPort() {
    if (updating || !port || sport) {
        if (!status.device.ready) {
            status.state = updating ? STATES.FLASHING : STATES.NODEVICE;
        }
        setTimeout(openSerialPort, 2000);
        return;
    }
    sport = new SerialPort(port, { baudRate: baud })
        .on('open', function() {
            evtlog("open: " + port);
            new LineBuffer(sport, onSerialLine);
            status.device.connect = Date.now();
            status.device.lines = 0;
            status.state = STATES.CONNECTING;
            status.print.pause = paused = false;
            lineno = 1;
            setTimeout(() => {
                if (status.device.lines < 2) {
                    evtlog("device not responding. reopening port.");
                    sport.close();
                }
            }, 3000);
        })
        .on('error', function(error) {
            sport = null;
            console.log(error);
            setTimeout(openSerialPort, 2000);
            status.device.connect = 0;
            status.device.ready = false;
        })
        // .on('line', onSerialLine)
        .on('close', function() {
            sport = null;
            evtlog("close");
            setTimeout(openSerialPort, 2000);
            status.device.close = Date.now();
            status.device.ready = false;
            status.state = STATES.NODEVICE;
        });
}

// handle a single line of serial input
function onSerialLine(line) {
    status.device.lines++;
    if (debug) {
        let cmd = (match[0] || {line:''}).line;
        console.log("<... " + (cmd ? cmd + " -- " + line : line));
    }
    status.device.line = Date.now();
    line = line.toString().trim();
    let matched = false;
    let istemp = false;
    let update = false;
    // parse M105/M155 temperature updates
    if (line.indexOf("T:") === 0) {
        istemp = true;
        // eliminate spaces before slashes " /"
        line = line.replace(/ \//g,'/').split(' ');
        // parse extruder/bed temps
        line.forEach(tok => {
            tok = tok.split(":");
            switch (tok[0]) {
                case 'T':
                    tok = tok[1].split("/");
                    status.temp.ext[0] = parseFloat(tok[0]);
                    status.target.ext[0] = parseFloat(tok[1]);
                    update = true;
                    break;
                case 'B':
                    tok = tok[1].split("/");
                    status.temp.bed = parseFloat(tok[0]);
                    status.target.bed = parseFloat(tok[1]);
                    update = true;
                    break;
            }
        });
    }
    if (starting && line.indexOf("M900 ") === 0) {
        // look for end of output on newly opened port
        cmdlog("<-- " + line, {});
        collect = [];
        starting = false;
        if (opt.kick) {
            processInput("*clearkick");
        }
        status.state = STATES.IDLE;
        evtlog("device ready");
    } else if (line.indexOf("ok") === 0 || line.indexOf("error:") === 0) {
        // match output to an initiating command (from a queue)
        if (line.indexOf("ok ") === 0 && collect) {
            line = line.substring(3);
            collect.push(line);
        }
        matched = match.shift();
        let from = matched ? matched.line : "???";
        let flags = matched ? matched.flags : {};
        // if checksumming is enabled, lines start with Nxxxx
        if (line.charAt(0) === 'N') {
            let lno = parseInt(line.split(' ')[0].substring(1));
            if (lno !== flags.lineno) {
                console.log({mismatch: line, lno, matched, collect});
            }
        }
        // callbacks used by M117 to track start of print
        if (matched && flags.callback) {
            flags.callback(collect, matched.line);
        }
        // emit collected lines
        if (collect && collect.length) {
            if (collect.length >= 4) {
                cmdlog("==> " + from, flags);
                collect.forEach((el, i) => {
                    if (i === 0) {
                        cmdlog("<-- " + el, flags);
                    } else {
                        cmdlog("    " + el, flags);
                    }
                });
            } else {
                cmdlog("==> " + from + " -- " + JSON.stringify(collect), flags);
            }
        }
        status.buffer.waiting = waiting = Math.max(waiting - 1, 0);
        if (status.update) {
            status.update = false;
        }
        collect = [];
    } else if (collect && !istemp) {
        collect.push(line);
    } else if (!istemp) {
        cmdlog("<-- " + line, {matched});
    }
    // force output of eeprom settings because it doesn't happen under these conditions
    if (line.indexOf("echo:EEPROM version mismatch") === 0) {
        evtlog("M503 on eeprom version mismatch");
        write("M503");
    }
    // status.buffer.match = match;
    status.buffer.collect = collect;
    processPortOutput(line, update);
    processQueue();
}

function processPortOutput(line, update) {
    if (line.length === 0) {
        return;
    }
    if (line === "start") {
        lineno = 1;
        update = true;
        starting = true;
        status.device.ready = true;
        status.device.boot = Date.now();
        status.print.clear = false;
        status.buffer.waiting = waiting = 0;
        collect = null;
        match = [];
        buf = [];
        // set port idle kill if doesn't come up as expected
        setTimeout(() => {
            if (starting && status.device.lines === 0) {
                evtlog("no serial activity detected ... reopening");
                sport.close();
            }
        }, 5000);
        // queue onboot commands
        onboot.forEach(cmd => {
            queue(cmd);
        });
        onboot = [];
    }
    // parse M114 x/y/z/e positions
    if (line.indexOf("X:") === 0) {
        let pos = status.pos = {};
        line.split(' ').forEach(tok => {
            tok = tok.split(':');
            if (tok.length === 2) {
                // do not overwrite value (Z: comes twice, for example)
                if (!pos[tok[0]]) {
                    pos[tok[0]] = parseFloat(tok[1]);
                    update = true;
                }
            }
        });
    }
    // parse M119 endstop status
    if (line.indexOf("_min:") > 0) {
        status.estop.min[line.substring(0,1)] = line.substring(6);
        update = true;
    }
    if (line.indexOf("_max:") > 0) {
        status.estop.max[line.substring(0,1)] = line.substring(6);
        update = true;
    }
    // parse Marlin version
    if (line.indexOf("echo:Marlin") === 0) {
        status.device.firm.ver = line.split(' ')[1];
    }
    // parse last compile info
    if (line.indexOf("echo: Last Updated") === 0) {
        status.device.firm.auth = line.substring(line.lastIndexOf('(')+1, line.lastIndexOf(')'));
    }
    // parse M503 settings status
    if (line.indexOf("echo:  M") === 0) {
        line = line.substring(7).split(' ');
        let code = {
            // M149: "temp_units",
            // M200: "filament",
            M92:  "steps_per",
            M203: "feedrate_max",
            M201: "accel_max",
            M204: "accel",
            M205: "advanced",
            M206: "offset",
            // M145: "heatup",
            M301: "pid",
            M900: "lin_advance"
        }[line.shift()] || null;
        let map = {};
        line.forEach(tok => {
            map[tok.substring(0,1)] = parseFloat(tok.substring(1));
        });
        if (code) {
            status.settings[code] = map;
        }
        update = true;
    }
    // resend on checksum errors
    if (line.indexOf("Resend:") === 0) {
        let from = line.split(' ')[1];
        evtlog(`resend from ${from}`, {error: true});
        sport.close();
        process.exit(-1);
    }
    // catch fatal errors and reboot
    if (!opt.noerror && line.indexOf("Error:") === 0) {
        status.error = {
            time: Date.now(),
            cause: line.substring(6)
        };
        evtlog(line, {error: true});
        if (line.indexOf("Error:checksum mismatch") === 0) {
            // ignore then act on 'Resend:'
        } else {
            try {
                sport.close();
                onboot = boot_error;
            } catch (e) { }
            if (opt.fragile) {
                if (debug) {
                    console.log({status});
                    process.exit(-1);
                }
            }
        }
    }
    // catch processing errors and reboot
    if (opt.fragile && line.indexOf("Unknown command:") >= 0) {
        evtlog(`fatal: ${line}`, {error: true});
        sport.close();
        if (debug) {
            console.log({status});
            process.exit(-1);
        }
    }
    if (update) {
        status.update = true;
    }
};

function clear_dir(dir, remove) {
    fs.readDirSync(dir).forEach(file => {
        fs.unlinkSync(path.join(dir, file));
    });
    if (remove) {
        fs.rmdirSync(dir);
    }
}

function sendFile(filename) {
    if (!checkDeviceReady()) {
        return;
    }
    if (!status.print.clear) {
        return evtlog("bed not marked clear. use *clear first", {error: true});
    }
    if (fs.statSync(filename).size === 0) {
        return evtlog("invalid file: empty", {error: true});
    }
    status.print.run = true;
    status.print.clear = false;
    status.print.filename = filename;
    status.print.outdir = filename.substring(0, filename.lastIndexOf(".")) + ".output";
    status.print.outseq = 0;
    status.print.start = Date.now();
    status.state = STATES.PRINTING;
    evtlog(`print head ${filename}`);
    try {
        let stat = fs.statSync(status.print.outdir);
        if (stat.isDirectory()) {
            clear_dir(status.print.outdir);
        } else {
            fs.mkdirSync(status.print.outdir);
        }
        let gcode = fs.readFileSync(filename).toString().split("\n");
        if (sdspool) {
            evtlog(`spooling "${filename} to SD"`);
            queue(`M28 print.gco`);
            gcode.forEach(line => {
                queue(line);
            });
            queue(`M29`);
            evtlog(`printing "${filename} from SD"`);
            queue(`M23 print.gco`);
            queue(`M24`);
        } else {
            gcode.forEach(line => {
                queue(line, {print: true});
            });
        }
    } catch (e) {
        evtlog("error sending file", {error: true});
        console.log(e);
    }
}

function processInput(line, channel) {
    try {
        processInput2(line, channel);
    } catch (e) {
        console.trace(line, e);
    }
}

function processInput2(line, channel) {
    line = line.toString().trim();
    // remap *name to an *exec call
    if (line.indexOf("*name ") === 0) {
        line = `*exec sudo bin/update-name.sh ${line.substring(6)}`;
    }
    // remap *wifi to an *exec call
    if (line.indexOf("*wifi ") === 0) {
        line = `*exec sudo bin/update-wifi.sh ${line.substring(6)}`;
    }
    // handle *exec calls
    if (line.indexOf("*exec ") === 0) {
        let cmd = line.substring(6);
        evtlog(`exec: ${cmd}`, {channel});
        exec(cmd, (err, stdout, stderr) => {
            (stdout || stderr).split('\n').forEach(line => {
                if (line) {
                    evtlog("--> " + line, {channel});
                }
            });
            if (stderr) {
                evtlog(JSON.stringify({cmd, err, stdout, stderr}));
            }
        });
        return;
    }
    // handle *buf reset
    if (line.indexOf('*buf ') === 0) {
        bufmax = parseInt(line.substring(5));
        return;
    }
    let pretty = undefined;
    switch (line) {
        case "*exit": return process.exit(0);
        case "*bounce": return sport ? sport.close() : null;
        case "*debug on": return debug = true;
        case "*debug off": return debug = false;
        case "*extrude on": return extrude = true;
        case "*extrude off": return extrude = false;
        case "*match":
            console.log({match});
            return;
        case "*list":
            if (channel) {
                channel.request_list = true;
            }
            return evtlog(JSON.stringify(dircache), {list: true, channel});
        case "*clearkick":
            status.print.clear = true;
        case "*kick":
            if (status.print.run) {
                return evtlog("print in progress");
            }
            return kickNext();
        case "*update": return update_firmware();
        case "*abort": return abort();
        case "*pause": return pause();
        case "*resume": return resume();
        case "*clear":
            status.print.clear = true;
            return evtlog("bed marked clear");
        case "*monitor on":
            if (channel && !channel.monitoring) {
                channel.monitoring = true;
                evtlog("monitoring enabled");
            }
            return;
        case "*monitor off":
            if (channel && channel.monitoring) {
                evtlog("monitoring disabled");
                channel.monitoring = false;
            }
            return;
        case "*status+":
            pretty = 2;
        case "*status":
            status.now = Date.now();
            status.flags.debug = debug;
            status.flags.extrude = extrude;
            if (channel) {
                channel.request_status = true;
            }
            return evtlog(JSON.stringify(status,undefined,pretty), {status: true});
    }
    if (line.indexOf("*update ") === 0) {
        let file = line.substring(8);
        if (file.indexOf(".hex") < 0) {
            file += ".hex";
        }
        return update_firmware(file);
    }
    if (line.indexOf("*upload ") === 0) {
        if (channel.linebuf) {
            // accumulate all input data to linebuffer w/ no line breaks
            channel.linebuf.enabled = false;
            upload = line.substring(8);
            // evtlog({upload});
        } else {
            evtlog({no_upload_possible: channel});
        }
    } else if (line.indexOf("*delete ") === 0) {
        let base = line.substring(8);
        let gcode = base.indexOf(".gcode");
        let files = null;
        if (gcode > 0) {
            base = base.substring(0, gcode);
        }
        files = [
            path.join(filedir, base + ".hex"),
            path.join(filedir, base + ".gcode"),
            path.join(filedir, base + ".print"),
            path.join(filedir, encodeURIComponent(base + ".gcode"))
        ];
        remove_files(files, (res) => {
            try {
                clear_dir(path.join(filedir, base + ".output"), true);
            } catch (e) {
                evtlog(`no output dir for ${base}`);
                console.log(e);
            }
            checkFileDir(true);
        });
    } else if (line.indexOf("*kick ") === 0) {
        if (status.print.run) {
            return evtlog("print in progress", {channel});
        }
        let file = line.substring(6);
        if (file.indexOf(".gcode") < 0) {
            file += ".gcode";
        }
        kickNamed(path.join(filedir, file));
    } else if (line.indexOf("*send ") === 0) {
        sendFile(line.substring(6));
    } else if (line.charAt(0) !== "*") {
        queuePriority(line, channel);
    } else {
        evtlog(`invalid command "${line.substring(1)}"`, {channel});
    }
};

function remove_files(files, ondone, res) {
    res = res || [];
    if (files && files.length) {
        let file = files.shift();
        fs.unlink(file, (err) => {
            res.push({file, err});
            remove_files(files, ondone, res);
        });
    } else {
        ondone(res);
    }
}

function update_firmware(hexfile, retry) {
    if (updating) {
        return;
    }
    if (sport) {
        if (retry === undefined) {
            retry = 3;
        }
        if (retry === 0) {
            evtlog(`update aborted. serial port open.`);
            return;
        }
        evtlog(`update delayed. serial port open. retries left=${retry}`);
        setTimeout(() => {
            update_firmware(hexfile, retry-1);
        }, 1000);
    }
    updating = true;
    let choose = hexfile || "marlin.ino.hex";
    let newest = 0;
    let fwdir = opt.fwdir || filedir || `${process.cwd()}/firmware`;
    if (!hexfile) {
        fs.readdirSync(fwdir).forEach(file => {
            if (file.indexOf(".hex") < 0) {
                return;
            }
            let stat = fs.statSync(`${fwdir}/${file}`);
            if (stat.mtimeMs > newest) {
                newest = stat.mtimeMs;
                choose = file;
            }
        });
    }
    if (sport) {
        sport.close();
    }
    evtlog(`flashing with ${choose}`, {error: true});
    let proc = spawn("avrdude", [
            "-patmega2560",
            "-cwiring",
            `-P${port}`,
            "-b115200",
            "-D",
            `-Uflash:w:${fwdir}/${choose}:i`
        ])
        .on('error', error => {
            updating = false;
            evtlog("flash update failed", {error: true});
        })
        .on('exit', code => {
            updating = false;
            if (code === 0) {
                evtlog(`flash update completed`, {error: true});
                setTimeout(() => {
                    // bounce controller after successful firmware update
                    process.exit(0);
                }, 1000);
            } else {
                evtlog("flash update failed", {error: true});
            }
        });
    new LineBuffer(proc.stdout);
    new LineBuffer(proc.stderr);
    proc.stdout.on('line', line => { if (line.toString().trim()) evtlog(line.toString()) });
    proc.stderr.on('line', line => { if (line.toString().trim()) evtlog(line.toString()) });
}

function checkDeviceReady() {
    if (!status.device.ready) {
        evtlog("device missing or not ready", {error: true});
        return false;
    }
    return true;
}

function abort() {
    if (!checkDeviceReady()) {
        return;
    }
    evtlog("print aborted", {error: true});
    onboot = boot_abort;
    // if printing, ensure filament retracts
    if (status.print.run) {
        onboot = onboot.concat(["G1 E20 F300"]);
    }
    sport.close(); // forces re-init of marlin
};

function pause() {
    if (paused || !checkDeviceReady()) {
        return;
    }
    evtlog("execution paused", {error: true});
    status.print.pause = paused = true;
};

function resume() {
    if (!paused || !checkDeviceReady()) {
        return;
    }
    evtlog("execution resumed", {error: true});
    status.print.pause = paused = false;
    processQueue();
};

function processQueue() {
    if (processing) {
        return;
    }
    processing = true;
    while (waiting < bufmax && buf.length && !paused) {
        let {line, flags} = buf.shift();
        status.buffer.queue = buf.length;
        status.print.mark = Date.now();
        write(line,flags);
    }
    if (buf.length === 0) {
        maxout = 0;
        if (status.print.run) {
            status.print.end = Date.now();
            status.print.run = false;
            status.print.progress = "100.00";
            status.state = STATES.IDLE;
            let fn = status.print.filename;
            let lp = fn.lastIndexOf(".");
            fn = `${fn.substring(0,lp)}.print`;
            fs.writeFileSync(fn, JSON.stringify(status.print));
            evtlog(`print done ${status.print.filename} in ${((status.print.end - status.print.start) / 60000)} min`);
        }
    } else {
        if (status.print.run) {
            status.print.progress = ((1.0 - (buf.length / maxout)) * 100.0).toFixed(2);
        }
    }
    processing = false;
};

function queue(line, flags) {
    let priority = flags && flags.priority;
    line = line.trim();
    if (line.length === 0) {
        return;
    }
    if (waiting < bufmax || (paused && priority)) {
        write(line, flags);
    } else {
        if (priority) {
            // find highest priority queue # and insert after
            let ind = 0;
            while (ind < buf.length) {
                let el = buf[ind];
                if (el.flags && el.flags.priority) {
                    ind++;
                    continue;
                }
                break;
            }
            buf.splice(ind, 0, {line, flags})
        } else {
            buf.push({line, flags});
        }
        status.buffer.queue = buf.length;
        maxout = Math.max(maxout, buf.length);
    }
};

function queuePriority(line, channel) {
    queue(line, {priority: true, channel});
}

function write(line, flags) {
    if (!line) {
        console.trace("missing line", line, flags);
        return;
    }
    if (line.indexOf("M2000") === 0) {
        pause();
        return;
    }
    let sci = line.indexOf(";");
    if (sci > 0) {
        line = line.substring(0, sci).trim();
    }
    flags = flags || {};
    switch (line.charAt(0)) {
        case ';':
            // layer change. capture picture
            if (line.indexOf(" layer ") > 0 && line.indexOf("@") > 0) {
                let seq = (status.print.outseq++).toString().padStart(4,'0');
                fs.link(
                    "/var/www/html/camera.jpg",
                    status.print.outdir + `/image-${seq}.jpg`,
                    err => {});
            }
            return;
        case '$': // grbl
        case '?': // grbl
        case '~': // grbl resume
        case 'M':
            // consume & report M117 Start
            if (line.indexOf('M117 Start') === 0) {
                flags.callback = () => {
                    status.print.prep = status.print.start;
                    status.print.start = Date.now();
                    evtlog(`print body ${status.print.filename}`);
                };
            }
        case 'G':
            // elide 'E' extrude moves when extrusion disabled
            if (extrude === false) {
                line = line.split(' ').filter(t => t.charAt(0) !== 'E').join(' ');
            }
            // extract position from gcode
            line.split(' ').forEach(t => {
                switch (t.charAt(0)) {
                    case 'X': status.pos.X = parseFloat(t.substring(1)); break;
                    case 'Y': status.pos.Y = parseFloat(t.substring(1)); break;
                    case 'Z': status.pos.Z = parseFloat(t.substring(1)); break;
                    case 'E': status.pos.E += parseFloat(t.substring(1)); break;
                }
            });
            match.push({line, flags});
            waiting++;
            status.buffer.waiting = waiting;
            break;
    }
    if (sport) {
        if (checksum) {
            flags.lineno = lineno;
            status.device.lineno = lineno;
            line = `N${lineno++} ${line}`;
            let cksum = 0;
            Buffer.from(line).forEach(ch => {
                cksum = cksum ^ ch;
            });
            line = `${line}*${cksum}`;
        }
        if (debug) console.log("...> " + line);
        cmdlog("--> " + line, flags);
        sport.write(`${line}\n`);
    } else {
        evtlog("serial port missing: " + line, flags);
    }
}

let known = {}; // known files
let printCache = {}; // cache of print

function checkFileDir(once) {
    if (!filedir) return;
    try {
        let prints = {};
        let recs = {};
        let valid = [];
        fs.readdirSync(filedir).forEach(name => {
            let lp = name.lastIndexOf(".");
            if (lp <= 0) {
                return;
            }
            let ext = name.substring(lp+1);
            let short = name.substring(0,lp);
            let stat = fs.statSync(path.join(filedir, name));
            let isnew = !known[name] || known[name] !== stat.mtimeMs;
            if (isnew) {
                known[name] = stat.mtimeMs;
            }
            if (ext === "gcode" || ext === "nc" || ext === "hex") {
                valid.push(recs[short] = {name, ext, size: stat.size, time: stat.mtimeMs});
            } else if (ext === "print") {
                if (isnew) {
                    try {
                        printCache[short] = JSON.parse(fs.readFileSync(path.join(filedir, name)));
                    } catch (e) { }
                }
                prints[short] = printCache[short];
            }
        });
        Object.keys(prints).forEach(key => {
            if (recs[key]) {
                recs[key].last = prints[key];
            }
        });
        dircache = valid.sort((a, b) => {
            return a.ext === b.ext ?
                b.time - a.time :
                a.ext > b.ext ? 1 : -1;
        });
        if (once) {
            processInput("*list");
        } else {
            setTimeout(checkFileDir, 2000);
        }
    } catch (e) {
        console.log(e);
    }
};

function kickNamed(name) {
    sendFile(name);
}

function kickNext() {
    for (let i=0; i<dircache.length; i++) {
        if (dircache[i].ext === 'gcode') {
            return sendFile(filedir + "/" + dircache[0].name);
        }
    }
    evtlog("no valid files", {error: true});
}

function headers(req, res, next) {
    res.setHeader("Access-Control-Allow-Origin", req.headers['origin'] || '*');
    res.setHeader("Access-Control-Allow-Credentials", true);
    res.setHeader("Access-Control-Allow-Headers", "X-Moto-Ajax");
    next();
}

function drophandler(req, res, next) {
    const dropkey = "/api/drop?name=";
    if (req.url.indexOf(dropkey) === 0 && req.method === 'POST') {
        let name = decodeURIComponent(req.url.substring(dropkey.length));
        let body = '';
        req.on('data', data => {
            body += data.toString();
        })
        req.on('end', () => {
            res.end("file received");
            fs.writeFile(path.join(filedir, name), body, () => {
                checkFileDir(true);
            });
        })
    } else {
        next();
    }
}

// probe network interfaces
function findNetworkAddress() {
    status.device.addr = [];
    let ifmap = os.networkInterfaces();
    let ifkeys = Object.keys(ifmap).forEach(key => {
        let ifc = ifmap[key];
        if (!Array.isArray(ifc)) {
            ifc = [ifc];
        }
        ifc.forEach(int => {
            if (int.internal === false && int.family === 'IPv4') {
                status.device.addr.push(int.address);
            }
        });
    });
    if (status.device.addr.length === 0) {
        setTimeout(findNetworkAddress, 5000);
    }
}

// -- start it up --

if (opt.help) {
    console.log([
        "usage: serial [options]",
        "   --device=<dev>   : path to serial port device",
        "   --baud=<rate>    : baud rate for serial device",
        "   --listen=<port>  : port for command interface",
        "   --webport=<port> : port to listen for web connections",
        "   --webdir=<dir>   : directory to serve on <webport>",
        "   --filedir=<dir>  : directory to watch for gcode",
        "   --stdin          : enable stdin as command interface",
        "   --grbl           : enable grbl command mode"
    ].join("\n"));
    process.exit(0);
}

if (opt.grbl) {
    mode = 'grbl';
}

if (opt.probe) {
    SerialPort.list((err, ports) => {
        ports.forEach(port => {
            console.log({
                com: port.comName,
                pnp: port.pnpId        || null,
                man: port.manufacturer || null,
                ven: port.vendorId     || null,
                prd: port.productId    || null,
                ser: port.serialNumber || null
            });
        });
        process.exit(0);
    });
    return;
}

// add stdout to clients
clients.push({console: true, monitoring: true, write: (line) => {
    process.stdout.write(`[${moment().format("HH:mm:ss")}] ${line}`);
}});

process.stdout.monitoring = true;

if (opt.stdin) {
    new LineBuffer(process.stdin);
    process.stdin.on("line", line => { processInput(line, clients[0]) });
    status.clients.stdin = 1;
}

if (opt.listen) {
    net.createServer(socket => {
        let dev = status.device;
        status.clients.net++;
        socket.linebuf = new LineBuffer(socket);
        socket.write(`*ready ${dev.name} ${dev.version} ${dev.firm.auth} ${dev.addr.join(',')}\n`);
        socket.on("line", line => { processInput(line, socket) });
        socket.on("close", () => {
            clients.splice(clients.indexOf(socket),1);
            status.clients.net--;
            let buffer = socket.linebuf.buffer;
            // store upload, if available
            if (upload && buffer && buffer.length) {
                let size = buffer.length;
                fs.writeFile(path.join(filedir, upload), buffer, (err) => {
                    evtlog({upload: upload, size, err});
                    checkFileDir(true);
                });
            }
        });
        clients.push(socket);
    }).listen(parseInt(opt.listen) || 4000);
}

if (opt.web || opt.webport) {
    const webdir = opt.webdir || "web/marlin";
    const webport = parseInt(opt.webport) || 4080;
    const handler = connect()
        .use(headers)
        .use(drophandler)
        .use(serve(process.cwd() + "/" + webdir + "/"));
    const server = http.createServer(handler).listen(webport);
    const wss = new WebSocket.Server({ server });
    wss.on('connection', (ws) => {
        status.clients.ws++;
        ws
            .on('close', () => {
                clients.splice(clients.indexOf(ws),1);
                status.clients.ws--;
            })
            .on('error', (error) => {
                console.log({wss_error: error});
            })
            .on('message', (message) => {
                processInput(message, ws);
            });

        let dev = status.device;
        ws.send(`*ready ${dev.name} ${dev.version} ${dev.firm.auth} ${dev.addr.join(',')}\n`);
        ws.write = (data) => {
            try {
                ws.send(data);
            } catch (e) {
                // client will be removed above on 'close' event
            }
        };
        clients.push(ws);
    });
    console.log({ webport, webdir });
}

function startup() {
    console.log({ devport: port || 'undefined', ctrlport: opt.listen, baud, mode, maxbuf: bufmax, version });
    openSerialPort();
    checkFileDir();
    findNetworkAddress();
}

if (!port) {
    probeSerial(nport => {
        if (nport) {
            port = nport;
        }
        startup();
    });
} else {
    startup();
}
