import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import EventEmitter from "events";
import { onlineSolver, PddlAction, PddlExecutor, Beliefset, PddlProblem, PddlDomain } from "@unitn-asa/pddl-client";
//import { onlineSolver } from "../../Deliveroo.js/packages/@unitn-asa/pddl-client/src/PddlOnlineSolver.js";
import depth_search_daemon from "./depth_search_daemon.js";
import fs from 'fs';


var AGENTS_OBSERVATION_DISTANCE
var MOVEMENT_DURATION
var PARCEL_DECADING_INTERVAL

let map_believes = new Beliefset();

let map;

let locked = new Map();




function readFile(path) {

    return new Promise((res, rej) => {

        fs.readFile(path, 'utf8', (err, data) => {
            if (err) rej(err)
            else res(data)
        })

    })

}



function createMapBelieves(map) {

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
            if (planClass.isApplicableTo(this.predicate[0], this.#parent)) {
                this.#current_plan = new planClass.constructor(this.#parent);

                try {
                    const plan_res = await this.#current_plan.execute(...this.predicate);
                    this.log('succesful intention', ...this.predicate, 'with plan', planClass.constructor.name, 'with result:', plan_res);
                    return plan_res
                } catch (error) {
                    if (this.stopped)
                        break;
                    this.log('failed intention', ...this.predicate, 'with plan', planClass.constructor.name, 'with error:', error);
                }
            }

        }

        if (this.stopped) throw ['stopped intention', ...this.predicate];


        throw ['no plan satisfied the intention ', ...this.predicate]
    }

}



class Plan {
    constructor(ag) {
        this.ag = ag
    }

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

    log(...args) {
        if (this.#parent && this.#parent.log)
            this.#parent.log('\t', ...args)
        else
            console.log(...args)
    }

    #sub_intentions = [];

    async subIntention(predicate) {
        const sub_intention = new Intention(this.ag, predicate);
        this.#sub_intentions.push(sub_intention);
        return sub_intention.achieve();
    }

}

class GoPickUp extends Plan {

    isApplicableTo(go_pick_up, ag) {
        if (this.ag == ag) {
  
            return go_pick_up == 'go_pick_up';
        }
    }

    async execute(go_pick_up, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y])
            .then(async () => {
                await this.ag.client.pickup()

                    .then(async (res_pick) => {


                        for (const par of res_pick) {
 
                            this.ag.me.carrying.set(par['id'], { id: par['id'], x: par['x'], y: par['y'], carriedBy: par['carriedBy']['id'], reward: par['reward'] })

                        if (this.stopped) throw ['stopped'];
                        await this.ag.check_delivery_cost()
                            .then((res) => {

                                if (res) {
                                    this.ag.stopCurrent()
                                    this.ag.push(['go_deliver'])
                                }
                            })


                        if (this.ag.carriedQty > 0) {
                            this.ag.push(['go_deliver'])
                        }
                        if (this.stopped) throw ['stopped'];
                    })
            })
        return true;
    }

}

class GoDeliver extends Plan {

    isApplicableTo(go_deliver, ag) {
        if (this.ag == ag) {
            return go_deliver == 'go_deliver';

        }
    }
    async execute(go_deliver) {

        let deliveryTile = await this.ag.nearestDelivery(this.ag.me);

        await this.subIntention(['go_to', deliveryTile.x, deliveryTile.y])
            .then(async (res) => {
                if (res) {
                    await this.ag.client.putdown()
                }
            })
            .then(() => {
                for (const [id, p] of this.ag.me.carrying.entries()) {

                    this.ag.parcels.delete(id);
                    this.ag.me.carrying.delete(id);
                    this.ag.client.shout(['delete', 'parcels', id])

                }
            })


        if (this.stopped) throw ['stopped'];

        return true;

    }

}


class Patrolling extends Plan {

    isApplicableTo(patrolling, ag) {
        if (this.ag == ag) {

            return patrolling == 'patrolling';
        }
    }


    async execute(patrolling) {

        if (this.stopped) throw ['stopped'];

        let min = Math.sqrt(map.tiles.size) / 3

        let max = -min
        let i_x = Math.round(Math.random() * (max - min) + min)
        let i_y = Math.round(Math.random() * (max - min) + min)
        let tile = { ...this.ag.me };
        tile.x = Math.round(tile.x + i_x);
        tile.y = Math.round(tile.y + i_y);


        if (tile.x >= 0 && tile.y >= 0 && map.xy(tile.x, tile.y)) {

            await this.subIntention(['go_to', tile.x, tile.y]);
            if (this.ag.parcels.size == 0) {

                this.ag.client.shout(['free', this.ag.me.id])
            }
        }
        if (this.stopped) throw ['stopped'];
        return true;
    }

}

class DepthSearchMove extends Plan {


    async up(m, f, t) {
        let status = await this.ag.client.move('up');
        if (status) {
            this.ag.believes.undeclare('at ' + m + ' ' + f);
            this.ag.believes.declare('at ' + m + ' ' + t);
        }
        else {
            console.log('failed move, pushing' + this.ag.currentIntention.predicate, this.ag.name)

            this.ag.intention_queue.unshift(this.ag.currentIntention.predicate)
            this.ag.stopCurrent()
            return false

        }
    }
    async down(m, f, t) {
        let status = await this.ag.client.move('down');
        if (status) {
            this.ag.believes.undeclare('at ' + m + ' ' + f);
            this.ag.believes.declare('at ' + m + ' ' + t);

        }
        else {
            console.log('failed move, pushing' + this.ag.currentIntention.predicate, this.ag.name)

            this.ag.intention_queue.unshift(this.ag.currentIntention.predicate)
            this.ag.stopCurrent()
            return false

        }
    }
    async left(m, f, t) {
        let status = await this.ag.client.move('left');
        if (status) {
            this.ag.believes.undeclare('at ' + m + ' ' + f);
            this.ag.believes.declare('at ' + m + ' ' + t);

        }
        else {
            console.log('failed move, pushing' + this.ag.currentIntention.predicate, this.ag.name)

            this.ag.intention_queue.unshift(this.ag.currentIntention.predicate)
            this.ag.stopCurrent()
            return false

        }
    }
    async right(m, f, t) {
        let status = await this.ag.client.move('right');
        if (status) {
            this.ag.believes.undeclare('at ' + m + ' ' + f);
            this.ag.believes.declare('at ' + m + ' ' + t);


        }
        else {
            console.log('failed move, pushing' + this.ag.currentIntention.predicate, this.ag.name)
            this.ag.intention_queue.unshift(this.ag.currentIntention.predicate)
            this.ag.stopCurrent()
            return false
        }
    }



    isApplicableTo(go_to, ag) {
        if (this.ag == ag) {

            return go_to == 'go_to';
        }
    }

    async execute(go_to, x, y) {
        if (x == this.ag.me.x && y == this.ag.me.y) {
            return true
        }
        this.ag.setBaseKnowledge(this.ag.me)
        this.log('DepthSearchMove', 'from', this.ag.me.x, this.ag.me.y, 'to', { x, y });
        if (!this.ag.believes.toPddlString().includes('at ' + this.ag.me.name)) {
            this.ag.believes.declare('at ' + this.ag.me.name + ' t' + Math.round(this.ag.me.x) + '_' + Math.round(this.ag.me.y));
        }

        let plan = [];
        await this.ag.planPath(this.ag.me, { x, y })
            .then((res) => { plan = res })


        if (!plan) {
            throw 'target not reachable';
        }



        const pddlExecutor = new PddlExecutor(
            {
                name: 'up', executor: this.up, ag: this.ag
            },
            {
                name: 'down', executor: this.down, ag: this.ag
            },
            {
                name: 'left', executor: this.left, ag: this.ag
            },
            {
                name: 'right', executor: this.right, ag: this.ag
            },)

        await pddlExecutor.exec(plan);
        if (Math.round(this.ag.me.x) != x || Math.round(this.ag.me.y) != y) {
            return false
        }


        return true;

    }
}



class agent {

    async reward(p, start = this.me) {

        let ret
        let speed = 1 / (MOVEMENT_DURATION / 1000)
        let p_rew = p[4]
        p = { x: p[1], y: p[2] }

        console.log('calculating reward of parcel ', p, ' for ', this.me.name)

        if (PARCEL_DECADING_INTERVAL == 1000000) {
            return 1 / (1 + this.distance(start, p))
        } 
        await this.nearestDelivery(p)
            .then((near) => {

                console.log('start', start, 'speed is', speed, 'the parcel will last ', (PARCEL_DECADING_INTERVAL / 1000) * p_rew, 'the distances dmp and dpd are', this.distance(start, p), ' ', this.distance(p, near))
                ret = PARCEL_DECADING_INTERVAL / 1000 * p_rew - ((this.distance(start, p) + this.distance(p, near)) / speed)

            })
        return ret
    }


    async nearestDelivery({ x, y }) {



        let sorted = Array.from(map.tiles.values()).filter(({ delivery }) => delivery).sort((a, b) => this.distance(a, { x, y }) - this.distance(b, { x, y }))
        
        for (const s of sorted) {
            if (this.distance(s, { x, y }) == 0 && (x != s.x || y != s.y)) {
                continue
            }
            return s
        }
        return false

    }


    async check_delivery_cost() {
    console.log('checking if is time to deliver...')

    this.intention_queue.sort((o1, o2) => this.distance({ x: o1.x, y: o1.y }, { ...this.me }) - this.distance({ x: o2.x, y: o2.y }, { ...this.me }))


    console.log(this.intention_queue)
    let ret = false
    if (PARCEL_DECADING_INTERVAL == 1000000) {
        console.log('returning false since the parcels have no decay interval')
        return false
    }

   
    let queue = Object.assign([], this.intention_queue)
    if (queue.length == 0 && this.carriedQty()) {
        console.log('returning true since the queue is empty and I am carrying something')
        return true
    }

    let par = queue[0]
    if (par[0] != 'go_pick_up' || !this.carriedQty()) {
        console.log('returning false because the intention is not a pickup or because I am not carrying anything')
        return false
    }
    let speed = 1 / (MOVEMENT_DURATION / 1000)
    let xypar = { x: par[1], y: par[2] }
    let dmp = this.distance(me, xypar)
    await this.nearestDelivery(me)
        .then(async (nearest_me) => {
            await this.nearestDelivery(xypar)
                .then(async (nearest_xypar) => {

                    let dmd = this.distance(me, nearest_me)
                    let ddp = this.distance(nearest_me, xypar)
                    let dpd = this.distance(xypar, nearest_xypar)

                    let carried = this.carriedReward()


                   
                    let second
                    console.log('non consegno', carried - this.carriedQty() * ((dmp + dpd) / speed))
                    second = carried / PARCEL_DECADING_INTERVAL / 1000 - this.carriedQty() * (dmd / speed)
                    console.log('consegno', second)
                    if (carried * PARCEL_DECADING_INTERVAL / 1000 - this.carriedQty() * ((dmp + dpd) / speed) < second) {

                        ret = true
                    }
                    else {
                        ret = false
                    }
                })
        })
    return ret

}


    distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
        if (x1 == x2 && y1 == y2) {
            return 0
        }
      
        let a = this.depth_search({ x: x1, y: y1 }, { x: x2, y: y2 });
        if (a.length == 0) {
            return Infinity
        }
        return a.length
    }


    get intention_queue() {
        return this.intention_queue;
    }


    log(...args) {
    }

    async push(predicate) {
        this.intention_queue.unshift(predicate);
      

    }

    intention_queue = new Array();


    currentIntention;

    stopCurrent() {
        if (this.currentIntention) {
            console.log('Stopping current intention:', this.currentIntention.predicate)
            locked.delete(this.currentIntention.predicate[3])
            this.currentIntention.stop();
        }
    }

    async loop() {
        while (true) {
            console.log('inizio loop')
            if (this.intention_queue.length > 0) {
                console.log('intention queue', this.intention_queue)
                this.intention_queue.sort((a, b) => this.distance({ x: a[1], y: a[2] }, { ...this.me }) - this.distance({ x: b[1], y: b[2] }, { ...this.me }))
                const predicate = this.intention_queue.shift();
                

                const intention = this.currentIntention = new Intention(this, predicate);

                if (predicate[0] == "go_pick_up") {

                 
                    await this.reward(predicate)
                        .then(async (res) => {
                            await this.client.ask(this.other['id'], ['evaluate', predicate])
                                .then(async (reply) => {
                                    console.log('the evaluation led to reply:', reply[2], ' res:', res)

                                    if (res > reply[2] && res > 0) {
                                        this.client.shout(['not_free', this.me.id])
                                        await intention.achieve()
                                            .catch(error => {
                                                if (!intention.stopped)
                                                    console.error('Failed intention', ...intention.predicate, 'with error:', error)
                                            })
                                            .then(async () => {
                                                
                                            })
                                    }
                                    else {
                                        if (res <= 0) {
                                            return
                                        }
                                        this.client.say['take', predicate]
                                        console.log('not worth', predicate, ' for ', this.me.name)

                                    }
                                })
                        })
                }
                else {
                    await intention.achieve()
                        .catch(error => {
                            if (!intention.stopped)
                                console.error('Failed intention', ...intention.predicate, 'with error:', error)
                        })
                        

                }
            }
            else {
              
                if (this.carriedQty() > 0) {
                    this.push(['go_deliver'])
                } else {
                    this.push(this.idle);
                }
            }

            await new Promise(res => setImmediate(res));
        }
    }

    carriedQty() {
        return this.me.carrying.size
    }

    carriedReward() {
        return Array.from(this.me.carrying.values()).reduce((acc, parcel) => acc + parcel.reward, 0)

        
    }

    setBaseKnowledge({ x, y }) {
        this.believes = new Beliefset()
        this.believes.declare('me ' + this.me.name)

        for (const e of map_believes.entries) {
            this.believes.declare(e[0])
        }
        this.believes.declare('at ' + this.me.name + ' t' + Math.round(x) + '_' + Math.round(y))

        for (const a of this.agents.values()) {
            this.believes.declare('occupied t' + Math.floor(a['x']) + '_' + Math.floor(a['y']))
        }

        return true
    }

    async planPath(start, end) {

        let plan;
        this.setBaseKnowledge(start)
        this.agents = new Map()
        if (this.believes.toPddlString().includes('at ' + this.me.name + ' t' + end.x + '_' + end.y + ')')) {
            return []
        }
        var pddlProblem = new PddlProblem(
            'deliveroo-problem',
            this.believes.objects.join(' '),
            this.believes.toPddlString(),
            'and (at ' + this.me.name + ' t' + end.x + '_' + end.y + ')'
        );

        let problem = await pddlProblem.toPddlString();
    
        let domain = await readFile('./domain-deliveroo.pddl')
            .then(async (dom) => {
                plan = await onlineSolver(dom, problem)
            })
            .catch((err) => {
                console.log(err)
                plan = false
            })
        return plan

    }




    constructor(name, token) {

        this.believes = new Beliefset();


        this.client = new DeliverooApi(
            'http://localhost:8080',
            token
        )
        this.client.onConfig((config) => {
            AGENTS_OBSERVATION_DISTANCE = config.AGENTS_OBSERVATION_DISTANCE;
            MOVEMENT_DURATION = config.MOVEMENT_DURATION;
            PARCEL_DECADING_INTERVAL = config.PARCEL_DECADING_INTERVAL == '1s' ? 1000 : 1000000;
            start_update();
        });




        this.depth_search = depth_search_daemon(this.client);

        this.me = { carrying: new Map() , declared : false};
        this.client.onYou(({ id, name, x, y, score }) => {
            
            this.me.id = id
            this.me.name = name
            if (!this.me.declared) {
                console.log('shouted')
                this.client.shout(['name_id', name, id])
                this.me.declared = true
            }
            this.me.x = x
            this.me.y = y
            this.me.score = score
            
        })

        if (!map) {
            map = {
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
            this.client.onMap((width, height, tiles) => {
                map.width = width;
                map.height = height;
                for (const t of tiles) {
                    map.add(t);
                }
                createMapBelieves(map)
            })
        }


        this.parcels = new Map()

        this.sensingEmitter = new EventEmitter();

        this.client.onParcelsSensing((perceived_parcels) => {
            let newParcel = false
            for (const p of perceived_parcels) {
                if (!this.parcels.has(p.id)) {
                    newParcel = true
                }
                this.parcels.set(p.id, p)
                if (p.carriedBy == this.me.id) {
                    this.me.carrying.set(p.id, p);
                }

            }
            if (newParcel) {
                this.sensingEmitter.emit('new_parcel')
            }
        })


        this.agents = new Map()

        this.client.onAgentsSensing(async (perceived_agents) => {
            for (const a of this.agents.values()) {
                for (const p of perceived_agents) {
                    if (p['id'] == a['id']) {
                        break
                    }
                    this.agents.delete(a.id)

                }
            }
            for (const p of perceived_agents) {
               
                this.agents.set(p.id, p)


            }


        })





        this.client.onMsg(async (id, name, msg, reply) => {
            console.log("new msg received from", name + ':', msg);
        

            if (msg[0] == 'free') {
                console.log('setting', msg[1], 'as free')
                this.other.free = true
            }

            if (msg[0] == 'not_free') {
                console.log('setting', msg[1], 'as not free')
                this.other.free = false
            }
            if (msg[0] == 'take') {
                console.log('taking ', msg[1])
                let found = false

                for (const pred of this.intention_queue) {
                    if (pred[3] == msg[1][3]) {
                        found = true
                    }
                }
                if (!found) {
                    this.push(msg[1])
                    console.log(this.me.name, 'i just inserted', msg[1], 'in my queue as requested')
                }
            }

            if (msg[0] == 'evaluate') {
                console.log(this.other.name, 'asked to evaluate ', msg[1])

                await this.reward(msg[1])
                    .then((res) => {
                        if (!this.currentIntention[0] == 'patrolling') {
                            console.log('replying', this.me.name, 'reward', res, ' msg[1] ', msg[1])
                            reply([this.me.name, 'reward', res])
                        }
                        else {
                            console.log('not doing anything')
                            reply([this.me.name, 'reward', res])
                        }
                        })
            
            }

            if (msg[0] == 'name_id') {

                this.other = { name: msg[1], id: msg[2] , free: false}
               
            }
            if (msg[0] == 'add') {
                if (msg[1] == 'parcels') {

                    
                    for (const par of msg[2]) {
                      
                        if (!this.parcels.has(par.id)) {
                           
                            this.parcels.set(par.id, par)
                        }
                    }
                   
                }
             
            }
            if (msg[0] == 'delete') {
                if (msg[1] == 'parcels') {
                    
                    this.parcels.delete(msg[2])
                   

                }

                if (msg[1] == 'agents') {
                    for (const age of msg[2]) {
                        this.agents.delete(age.id)
                    }
                   

                }
                if (msg[1] == 'predicate') {
                   
                    console.log('removing from my queue', this.intention_queue, msg[2], 'parcels', this.parcels)
                    let ind = this.intention_queue.indexOf(msg[2])
                    if (ind != -1) {
                        this.intention_queue.splice(ind, 1)
                    }
                }
            }

                if (reply)
                    try {
                        console.log('i am replying', this.me.name)
                        reply(answer)
                    } catch { (error) => console.error(error) }
        });




        this.sensingEmitter.on("new_parcel", async () => {

            console.log('neeeeeeeew')
            if (this.other) {



                let current_position = { ...this.me }
                let tmp = Array.from(this.parcels.values())
                tmp.sort((o1, o2) => this.distance({ x: o1.x, y: o1.y }, current_position) - this.distance({ x: o2.x, y: o2.y }, current_position))

                for (const par of tmp) {

                    let found = false

                    for (const pred of this.intention_queue) {
                        if (pred[3] == par.id) {
                            found = true
                        }
                    }
                    if (!found) {
                        
                        if (!locked.has(par[3])) {
                            let predicate = ['go_pick_up', par.x, par.y, par.id, par.reward]

                            if (this.currentIntention.predicate[0] != 'patrolling' && this.other.free) {
                                this.client.say(this.other.id, ['take', predicate])
                            }
                            else {
                                await this.reward(predicate)
                                    .then(async (res) => {
                                       

                                        await this.client.ask(this.other['id'], ['evaluate', predicate])
                                            .then(async (reply) => {
                                                console.log(this.me.name, ' recvd', reply)
                                                if (res > reply[2]) {
                                                    locked.set(predicate[3], predicate)
                                                    
                                                    if (res > 0) {
                                                        this.push(predicate)
                                                    }
                                                }
                                                else {
                                                    this.client.say(this.other.id, ['take', predicate])

                                                }
                                                console.log(reply)
                                            })
                                    })
                            }
                        }


                    }
                }
            }

        })


        this.idle = ["patrolling"];
        this.loop();

    }
}


const b = new agent('agent_b', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjI0YjNlY2U5MzQxIiwibmFtZSI6ImFnZW50X2IiLCJpYXQiOjE2ODg0NTQ0ODV9.Ec8YmTZip4wjVf5vMEd6d-YTOjAol-zEKbeHQV6sVLs')
const a = new agent('agent_a', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjMyNGIzZWNlOTM0IiwibmFtZSI6ImFnZW50X2EiLCJpYXQiOjE2ODg0NTQ0NTd9.k5woOEo9qaMOARJycHe22hA22u0t7OuvebHOYUi9lng')

const group = [a, b]

const planLibrary = [];




planLibrary.push(new GoPickUp(b))
planLibrary.push(new Patrolling(b))
planLibrary.push(new GoDeliver(b))
planLibrary.push(new DepthSearchMove(b))
planLibrary.push(new GoPickUp(a))
planLibrary.push(new Patrolling(a))
planLibrary.push(new GoDeliver(a))
planLibrary.push(new DepthSearchMove(a))

async function updateStatus() {
    console.log('called update status')
    for (const ag of group) {
        if (ag.parcels) {
            for (const pre of ag.intention_queue) {
                if (pre[4] == 1) {
                    ag.intention_queue.splice(ag.intention_queue.indexOf(pre), 1)
                }
                pre[4] -= 1
                console.log(pre)
            }

            for (const p of ag.parcels.values()) {
                if (p['reward'] == 1) {
                    ag.parcels.delete(p['id'])

                }
                p['reward'] -= 1

            }
            for (const p of ag.me.carrying.values()) {
                if (p['reward'] == 1) {
                    ag.me.carrying.delete(p['id'])

                }
                let p2 = p
                p2['reward'] -= 1
                ag.me.carrying.set(p['id'], p2)
            }


        }

    }

}


let started = false

function start_update() {
    if (!started) {

        started = true
        setInterval(updateStatus, PARCEL_DECADING_INTERVAL)
    }
}