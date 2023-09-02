import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import EventEmitter from "events";
import { onlineSolver, PddlAction, PddlExecutor, Beliefset, PddlProblem, PddlDomain } from "@unitn-asa/pddl-client";
//import { onlineSolver } from "../../Deliveroo.js/packages/@unitn-asa/pddl-client/src/PddlOnlineSolver.js";
import depth_search_daemon from "./depth_search_daemon.js";
import fs from 'fs';

// function that estimates the distance between two positions.
function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {

    let a = depth_search({ x: x1, y: y1 }, { x: x2, y: y2 });
    if (a.length == 0) {
        return Infinity
    }
    return a.length
}


// function that retrieves the delivery tile nearest to the given position, without considering possible agents in the way
async function nearestDelivery({ x, y }) {
    let sorted = Array.from(map.tiles.values()).filter(({ delivery }) => delivery).sort((a, b) => distance(a, { x, y }) - distance(b, { x, y }))
    let p = undefined
    for (const s of sorted) {
        if (distance(s, { x, y }) == 0 && (x != s.x || y != s.y)) {
            continue
        }
        return s
    }
    return false

}

function carriedQty() {
    return me.carrying.size
}


function carriedReward() {
    console.log('I am carrying')
    console.log(me.carrying.values())
    return Array.from(me.carrying.values()).reduce((acc, parcel) => acc + parcel.reward, 0)
}

// modifies the believes of the agent adding information about the map, for the representation of the position of the tile it was decided to only use the predicates down and right
// swapping the two arguments if needing to declare up or left
function createMapBelieves(map) {
    console.log('creating map believes')

    for (const [id, t] of map.tiles.entries()) {

        const y = Math.floor(id / 1000)
        const x = id - y * 1000
        map_believes.declare('tile t' + x + '_' + y)
        if (map.tiles.has(id + 1)) {

            map_believes.declare('right t' + (x + 1) + '_' + y + ' t' + x + '_' + y)

        }
        if (map.tiles.has(id - 1000)) {

            map_believes.declare('down t' + x + '_' + (y - 1) + ' t' + x + '_' + y)

        }

    }

    return map_believes
}



async function reward(p, start = me) {
    let ret
    let speed = 1 / (MOVEMENT_DURATION / 1000)
    let p_rew = p[4]
    p = { x: p[1], y: p[2] }
    if (PARCEL_DECADING_INTERVAL == 1000000) {
        return 1 / (1 + distance(start, p))
    }
    await nearestDelivery(p)
        .then((near) => {
            //console.log('start',start,'speed is', speed, 'the parcel will last ', (PARCEL_DECADING_INTERVAL / 1000) * p['reward'], 'the distances dmp and dpd are', distance(start, p), ' ', distance(p, near) ) 
            ret = PARCEL_DECADING_INTERVAL / 1000 * p_rew - ((distance(start, p) + distance(p, near)) / speed)
            //console.log(p_rew, distance(start, p), distance(p, near), speed, 'ret', ret)

        })
    return ret
}


// Evaluates if, given the current position, carried parcels, distance from the delivery tile and distance from the next parcel, it is worth to deliver now or wait to pick up the next
// parcel.
async function check_delivery_cost() {
    console.log('checking if is time to deliver...')

    myAgent.intention_queue.sort((o1, o2) => distance({ x: o1.x, y: o1.y }, { ...me }) - distance({ x: o2.x, y: o2.y }, { ...me }))


    console.log(myAgent.intention_queue)
    let ret = false
    if (PARCEL_DECADING_INTERVAL == 1000000) {
        console.log('returning false since the parcels have no decay interval')
        return false
    }

    //console.log('inside check_delivery_cost')
    let queue = Object.assign([], myAgent.intention_queue)
    if (queue.length == 0 && carriedQty()) {
        console.log('returning true since the queue is empty and I am carrying something')
        return true
    }



    let par = queue[0]
    if (par[0] != 'go_pick_up' || !carriedQty()) {
        console.log('returning false because the intention is not a pickup or because I am not carrying anything')
        return false
    }
    let speed = 1 / (MOVEMENT_DURATION / 1000)
    let xypar = { x: par[1], y: par[2] }
    let dmp = distance(me, xypar)
    await nearestDelivery(me) 
        .then(async (nearest_me) => {
            await nearestDelivery(xypar)
                .then(async (nearest_xypar) => {

                    let dmd = distance(me, nearest_me)
                    let ddp = distance(nearest_me, xypar)
                    let dpd = distance(xypar, nearest_xypar)

                    let carried = carriedReward()


                    //console.log('carried', carriedReward(), 'dmd+ddp', dmd+ddp, 'parreward', par[4], 'dmd+ddp+dpd', dmd+ddp+dpd, 'speed',speed)
                    let second
                    console.log('non consegno', carried - carriedQty() * ((dmp + dpd) / speed))
                            second = carried/PARCEL_DECADING_INTERVAL/1000 - carriedQty() * (dmd / speed) 
                            console.log('consegno', second)
                    if (carried*PARCEL_DECADING_INTERVAL/1000 - carriedQty() * ((dmp + dpd) / speed) < second) {

                        ret = true
                    }
                    else {
                        ret = false
                    }
                })
        })
    return ret

}




// Updates the informations contained in parcels, reducing every PARCEL_DECADING_INTERVAL the reward of the parcels and deleting the ones that reach 0, this function will be called
// trough a setInterval in the configuration part of this script.
async function updateStatus() {
    if (!myAgent.intention_queue || !parcels || !me) {
        return false
    }
    if (parcels) {
        for (const pre of myAgent.intention_queue) {
            if (pre[4] == 1) {
                myAgent.intention_queue.splice(myAgent.intention_queue.indexOf(pre), 1)
            }
            pre[4] -= 1
        }

        for (const p of parcels.values()) {
            if (p['reward'] == 1) {
                parcels.delete(p['id'])

            }
            p['reward'] -= 1

        }
        for (const p of me.carrying.values()) {
            if (p['reward'] == 1) {
                me.carrying.delete(p['id'])

            }
            let p2 = p
            p2['reward'] -= 1
            me.carrying.set(p['id'], p2)
        }
        //console.log(ag.me.name, 'has : \n', 'parcels: ', ag.parcels, '\n', 'agents: ', ag.agents, '\n', 'intentions: ', ag.intention_queue, '\n', 'current intention: ', ag.currentIntention.predicate)

    }



}


function readFile(path) {

    return new Promise((res, rej) => {

        fs.readFile(path, 'utf8', (err, data) => {
            if (err) rej(err)
            else res(data)
        })

    })

}



// Create a knowledge base needed to create a plan, the knowledge base includes the map believes, the current position of the agent, and the tiles currently occupied by other agents
function setBaseKnowledge({ x, y }) {
    believes = new Beliefset()
    for (const e of map_believes.entries) {
        believes.declare(e[0])
    }
    believes.declare('at me t' + Math.round(x) + '_' + Math.round(y))

    for (const a of agents.values()) {
        believes.declare('occupied t' + Math.floor(a['x']) + '_' + Math.floor(a['y']))
    }

    return true
}


// Create a plan to move from the starting position to the end, to do so it first call setBaseKnowledge, it then creates a pddlProblem and asks onlineSolver for a solution,
// the domain needed is defined in the file domain-deliveroo.pddl
async function planPath(start, end) {

    let plan;
    setBaseKnowledge(start)


    var pddlProblem = new PddlProblem(
        'deliveroo-problem',
        believes.objects.join(' '),
        believes.toPddlString(),
        'and (at me t' + end.x + '_' + end.y + ')'
    );
    let problem = await pddlProblem.toPddlString()
    let domain = await readFile('./domain-deliveroo.pddl')
        .then(async (dom) => {

            plan = await onlineSolver(dom, problem);
        })
        .catch(() => {
            console.log('server busy')
        })


    agents = new Map()

    return plan

}


const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Ijg5OTMyMzkzMDUzIiwibmFtZSI6InJ1dnNpbCIsImlhdCI6MTY4MTM5NTc2Nn0.ohdPdAtLXcyEkXtsOvrf6rSi8wLTDXgfkIgJh5h8EaM'
)

var AGENTS_OBSERVATION_DISTANCE
var MOVEMENT_DURATION
var PARCEL_DECADING_INTERVAL
client.onConfig((config) => {
    AGENTS_OBSERVATION_DISTANCE = config.AGENTS_OBSERVATION_DISTANCE;
    MOVEMENT_DURATION = config.MOVEMENT_DURATION;
    PARCEL_DECADING_INTERVAL = config.PARCEL_DECADING_INTERVAL == '1s' ? 1000 : 1000000;
    setInterval(updateStatus, PARCEL_DECADING_INTERVAL)
});

const depth_search = depth_search_daemon(client);
const map_believes = new Beliefset();
let believes = new Beliefset();
map_believes.declare('me me')

const me = { carrying: new Map() };

client.onYou(({ id, name, x, y, score }) => {
    me.id = id
    me.name = name
    me.x = x
    me.y = y
    me.score = score
})

const map = {
    width: undefined,
    height: undefined,
    tiles: new Map(),
    add: function (tile) {
        const { x, y } = tile;
        return this.tiles.set(x + 1000 * y, tile);
    },
    xy: function (x, y) {
        return this.tiles.get(x + 1000 * y)
    }
};

client.onMap(async (width, height, tiles) => {
    map.width = width;
    map.height = height;
    for (const t of tiles) {
        map.add(t);
    }
    createMapBelieves(map)
})



const parcels = new Map()

const sensingEmitter = new EventEmitter();


client.onParcelsSensing(async (perceived_parcels) => {
    let newParcel = false
    for (const p of perceived_parcels) {
        if (!parcels.has(p.id)) {
            newParcel = true
        }
        parcels.set(p.id, p)
        if (p.carriedBy == me.id) {
            me.carrying.set(p.id, p);
        }
    }
    if (newParcel) {
        sensingEmitter.emit('new_parcel')
    }
})

let agents = new Map()

client.onAgentsSensing(async (perceived_agents) => {
    for (const p of perceived_agents) {
        if (!agents.has(p.id)) {
            sensingEmitter.emit('new_agent')
        }
        agents.set(p.id, p)
    }
})


sensingEmitter.on("new_parcel", async () => {

    console.log('I saw a new parcel')
    console.log(me.carrying)
    myAgent.intention_queue = []

    let current_position = { ...me }
    let tmp = Array.from(parcels.values())
    tmp.sort((o1, o2) => distance({ x: o2.x, y: o2.y }, current_position) - distance({ x: o1.x, y: o1.y }, current_position))
    for (const par of tmp) {
        let pred = ['go_pick_up', par.x, par.y, par.id, par.reward]
        if (par && !par.carriedBy) {
            myAgent.push(pred)
        }
    }
})





class Intention {

    #current_plan;

    #stopped = false;
    get stopped() {
        return this.#stopped;
    }
    stop() {
        this.#stopped = true;
        if (this.#current_plan)
            this.#current_plan.stop();
    }


    #parent;


    get predicate() {
        return this.#predicate;
    }
    #predicate;

    constructor(parent, predicate) {
        this.#parent = parent;
        this.#predicate = predicate;
    }

    log(...args) {
        if (this.#parent && this.#parent.log)
            this.#parent.log('\t', ...args)
        else
            console.log(...args)
    }

    #started = false;

    async achieve() {
        if (this.#started)
            return this;
        else
            this.#started = true;

        for (const planClass of planLibrary) {

            if (this.stopped)
                break;

            if (planClass.isApplicableTo(...this.predicate)) {
                this.#current_plan = new planClass(this.parent);

                try {
                    const plan_res = await this.#current_plan.execute(...this.predicate)
                        .catch((error) => {
                            console.log('gotchu', error)
                        })


                    this.log('succesful intention', ...this.predicate, 'with plan', planClass.name, 'with result:', plan_res);
                    return plan_res
                } catch (error) {
                    if (this.stopped)
                        break;
                    this.log('failed intention', ...this.predicate, 'with plan', planClass.name, 'with error:', error);
                }
            }

        }

        if (this.stopped) throw ['stopped intention', ...this.predicate];


        throw ['no plan satisfied the intention ', ...this.predicate]
    }

}


const planLibrary = [];

class Plan {

    #stopped = false;
    stop() {
        this.#stopped = true;
        for (const i of this.#sub_intentions) {
            i.stop();
        }
    }
    get stopped() {
        return this.#stopped;
    }


    #parent;

    constructor(parent) {
        this.#parent = parent;
    }

    log(...args) {
        if (this.#parent && this.#parent.log)
            this.#parent.log('\t', ...args)
        else
            console.log(...args)
    }

    #sub_intentions = [];

    async subIntention(predicate) {
        const sub_intention = new Intention(this, predicate);
        this.#sub_intentions.push(sub_intention);
        return sub_intention.achieve()
    }

}

class GoPickUp extends Plan {

    static isApplicableTo(go_pick_up, x, y, id) {
        return go_pick_up == 'go_pick_up';
    }

    async execute(go_pick_up, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y])
            .then(async () => {
                await client.pickup()
                    .then(async (res_pick) => {
                       
                        for (const par of res_pick) {
                            me.carrying.set(par['id'], { id: par['id'], x: par['x'], y: par['y'], carriedBy: par['carriedBy']['id'], reward: par['reward'] })
                        }
                        await check_delivery_cost()
                            .then((res) => {
                                console.log('checking cost', res)
                                if (res) {
                                    myAgent.push(['go_deliver'])
                                }
                            })

                        if (this.stopped) throw ['stopped'];
                    })
            })

        return true;
    }

}

class GoDeliver extends Plan {

    static isApplicableTo(go_deliver) {
        return go_deliver == 'go_deliver';
    }

    async execute(go_deliver) {
        console.log('decided to deliver')
       let deliveryTile = await nearestDelivery({...me})
        await this.subIntention(['go_to', deliveryTile.x, deliveryTile.y])
            .then(async (res) => {
                if (res) {
                    await client.putdown()
                }
            })
            .then(() => {
                for (const [id, p] of me.carrying.entries()) {

                    parcels.delete(id);
                    me.carrying.delete(id);

                }
            })
        if (this.stopped) throw ['stopped'];
        return true;

    }

}


class Patrolling extends Plan {

    static isApplicableTo(patrolling) {
        return patrolling == 'patrolling';
    }


    async execute(patrolling) {
        if (myAgent.intention_queue.length == 0 && carriedQty()) {
            myAgent.push(['go_deliver'])
        }
        if (this.stopped) throw ['stopped'];
        let min = Math.sqrt(map.tiles.size) / 3
        let max = -min
        let i_x = Math.round(Math.random() * (max - min) + min)
        let i_y = Math.round(Math.random() * (max - min) + min)
        let tile = { ...me };
        tile.x = Math.round(tile.x + i_x);
        tile.y = Math.round(tile.y + i_y);

        if (tile.x >= 0 && tile.y >= 0 && map.xy(tile.x, tile.y)) {
            await this.subIntention(['go_to', tile.x, tile.y]);
        }
        if (this.stopped) throw ['stopped'];
        return true;
    }

}

class PlannedMove extends Plan {


    async up(m, f, t) {
        if (this.stopped) {
            throw ['stopped']
        }
        let status = await client.move('up');
        if (status) {
            believes.undeclare('at me ' + f);
            believes.declare('at me ' + t);
            believes.declare('at me ' + t);
        }
        else {
            console.log('failed move', me.x, me.y)
            myAgent.intention_queue.unshift(myAgent.currentIntention.predicate)
            myAgent.stopCurrent()
            return false

        }
    }
    async down(m, f, t) {
        if (this.stopped) {
            throw ['stopped']
        }
        let status = await client.move('down');
        if (status) {
            believes.undeclare('at me ' + f);
            believes.declare('at me ' + t);

        }
        else {
            console.log('failed move', me.x, me.y)
            myAgent.intention_queue.unshift(myAgent.currentIntention.predicate)
            myAgent.stopCurrent()
            return false

        }
    }
    async left(m, f, t) {
        if (this.stopped) {
            throw ['stopped']
        }
        let status = await client.move('left');
        if (status) {
            //console.log('me from' + (me.x + 0.4) + ' ' + me.x)
            believes.undeclare('at me ' + f);
            believes.declare('at me ' + t);
        }
        else {
            console.log('failed move', me.x, me.y)
            myAgent.intention_queue.unshift(myAgent.currentIntention.predicate)
            myAgent.stopCurrent()
            return false

        }
    }
    async right(m, f, t) {
        if (this.stopped) {
            throw ['stopped']
        }
        let status = await client.move('right');
        if (status) {
            //console.log('me from' + (me.x - 1) + ' ' + me.x)
            believes.undeclare('at me ' + f);
            believes.declare('at me ' + t);
        }
        else {
            console.log('failed move', me.x, me.y)
            myAgent.intention_queue.unshift(myAgent.currentIntention.predicate)
            myAgent.stopCurrent()
            return false
        }
    }



    static isApplicableTo(go_to, x, y) {
        return go_to == 'go_to';
    }

    async execute(go_to, x, y) {
        if (x == me.x && y == me.y) {
            return true
        }
        setBaseKnowledge(me)
        this.log('PlannedMove', 'from', me.x, me.y, 'to', { x, y });
        if (!believes.toPddlString().includes('at me ')) {
            believes.declare('at me t' + Math.round(me.x) + '_' + Math.round(me.y));
        }

        let plan = [];
        await planPath(me, { x, y })
            .then((res) => { plan = res })


        if (!plan) {
            throw 'target not reachable';
        }



        const pddlExecutor = new PddlExecutor(
            {
                name: 'up', executor: this.up
            },
            {
                name: 'down', executor: this.down
            },
            {
                name: 'left', executor: this.left
            },
            {
                name: 'right', executor: this.right
            },)

        await pddlExecutor.exec(plan)
        if (Math.round(me.x) != x || Math.round(me.y) != y) {
            return false
        }


        return true;

    }
}





planLibrary.push(GoPickUp)
planLibrary.push(Patrolling)
planLibrary.push(GoDeliver)
planLibrary.push(PlannedMove)







class IntentionRevision {

    intention_queue = new Array();
    get intention_queue() {
        return this.intention_queue;
    }

    currentIntention;

    stopCurrent() {
        if (this.currentIntention)
            this.currentIntention.stop();
    }

    async loop() {
        while (true) {
            let valid = true
            if (this.intention_queue.length > 0) {

                const predicate = this.intention_queue.shift();
                console.log('shifted ', predicate, 'remaining queue', myAgent.intention_queue)
                const intention = this.currentIntention = new Intention(this, predicate);

                if (intention.predicate[0] == "go_pick_up") {
                    let id = intention.predicate[3]
                    let p = parcels.get(id)
                    if (p) {
                        let dist
                        console.log('choosing', predicate)
                        await nearestDelivery({ x: p['x'], y: p['y'] })
                            .then((nearest) => {
                                dist = (distance({ ...me }, { x: p['x'], y: p['y'] }) + distance({ x: p['x'], y: p['y'] }, nearest))
                                if (PARCEL_DECADING_INTERVAL != 1000000) {
                                    if (p.carriedBy || predicate[4] / (PARCEL_DECADING_INTERVAL / 1000) < dist * (MOVEMENT_DURATION / 1000)) {
                                        console.log('rejecting predicate', predicate)
                                        valid = false
                                    }
                                }

                            })
                    }
                }
                if (valid) {
                    await intention.achieve()
                        .catch(error => {
                            if (!intention.stopped)
                                console.error('Failed intention', ...intention.predicate, 'with error:', error)
                        });
                }
            }
            else {
                if (carriedQty() > 0) {
                    this.push(['go_deliver'])
                } else {
                this.push(this.idle);
                }
            }

            await new Promise(res => setImmediate(res));
        }
    }



    async push(predicate) {

        this.intention_queue.unshift(predicate);
        if (this.currentIntention && this.currentIntention[0] == 'patrolling') {
            this.stopCurrent()
        }
    }
}


const myAgent = new IntentionRevision();
myAgent.idle = ["patrolling"];
myAgent.loop();



